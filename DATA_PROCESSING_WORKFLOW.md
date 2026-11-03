# Terpene Atlas 数据处理与建库流程

本文记录项目从原始数据表格到 MySQL 数据库的处理过程。流程分为三个部分：整理原始表格、生成入库文件、执行 ETL。下文的路径均相对于项目根目录，脚本顺序以当前代码为准。

## 1. 准备原始表格

处理起点是 UniProt 统一导出的 TSV 表。TSV 使用制表符分隔列，适合保存蛋白名称、序列、功能注释等较长字段。各步骤通过 `Entry`，也就是 UniProt accession，关联同一个蛋白条目。

原始表主要包含以下信息：

| 信息类型 | 主要内容 |
| --- | --- |
| 条目基本信息 | Entry、Entry Name、Reviewed、Organism |
| 名称与功能 | Protein names、Gene Names、Function、EC number |
| 反应注释 | Rhea ID、Catalytic activity |
| 蛋白序列 | Sequence、Length、Mass、Alternative sequence |
| 补充注释 | GO 生物过程、PubMed、DOI、GeneID、异构体信息 |

项目使用同一次检索下载整个 `(terpene)` 数据集，再根据 `Reviewed` 列在本地拆成两个来源：人工审阅的 Swiss-Prot 和未经人工审阅的 TrEMBL。两份输入分别保存为：

```text
update_tool/_src/swiss_prot/output_uniprot_unified.tsv
update_tool/_src/trembl/output_uniprot_unified.tsv
```

如果已经准备好这两份表格，可以直接开始后面的处理。需要重新获取时，在项目根目录执行：

```powershell
python update_tool/download_uniprot.py
```

原始表中的标识符、序列和列名需要保持原样。用表格软件查看时，应避免将编号自动转换为数字或日期，也不要把多个值随意合并到一个单元格中。

## 2. 按来源整理数据

两个来源分别运行相同的处理步骤，输出保存在各自的 `_src/<source>/` 目录中。这个阶段以蛋白条目为单位，先拆出各类注释，再生成适合详情页和反应卡使用的汇总表。

| 顺序 | 脚本 | 处理内容 | 输出文件 |
| --- | --- | --- | --- |
| 1 | `parse_names.py` | 从蛋白名称字段解析推荐名、替代名和 EC 信息 | `output_parsed.tsv` |
| 2 | `fetch_go.py` | 提取 GO 生物过程注释 | `output_go.tsv` |
| 3 | `fetch_isoform.py` | 整理异构体及其序列 | `output_isoform.tsv` |
| 4 | `fetch_rhea.py` | 补充反应方程、方向、参与化合物和结构信息 | `output_rhea.tsv` |
| 5 | `fetch_references.py` | 整理参考文献 | `output_references.tsv` |
| 6 | `fetch_sequence_links.py` | 整理核酸、蛋白序列的外部编号和链接 | `output_sequence_links.tsv` |
| 7 | `build_names_split.py` | 生成以 Entry 为单位的名称表 | `output_names_split.tsv` |
| 8 | `build_rhea_summary.py` | 生成反应卡摘要 | `output_rhea_summary.tsv` |
| 9 | `build_enzyme_merged.py` | 汇总同一个酶对应的反应 | `output_enzyme_merged.tsv` |
| 10 | `build_terpene_only.py` | 整理反应的底物和产物信息 | `output_terpene_only.tsv` |
| 11 | `rebuild_master.py` | 将名称和子表注释汇总成酶详情总表 | `output_master.tsv` |

部分步骤还会访问 UniProt 或 Rhea 接口，因此有了原始 TSV，也不代表后续过程可以完全离线运行。化学结构信息同时使用 `update_tool/chebi_data/` 下的 ChEBI 参考数据。

在项目根目录执行：

```powershell
python update_tool/run_all.py --source=swiss_prot
python update_tool/run_all.py --source=trembl
```

默认情况下，脚本会跳过已经存在的输出文件。更换原始表后应加 `--force` 重建，以免继续使用上一批数据的中间结果：

```powershell
python update_tool/run_all.py --source=swiss_prot --force
python update_tool/run_all.py --source=trembl --force
```

## 3. 合并跨来源数据

酶的名称、序列和注释按来源保存，化合物和底物—产物对则需要统一处理。同一种化合物可能出现在两个来源的反应中，同一对底物和产物也可能对应多个酶，因此不能简单地分别生成两套节点。

两个来源处理完后执行：

```powershell
python update_tool/run_all.py --merge --force
```

汇合步骤先检查所有已登记来源的分段文件是否齐全，再生成以下文件，保存到 `update_tool/_merged/`：

| 文件 | 内容 |
| --- | --- |
| `output_terpene_pairs.tsv` | 按底物和产物分组，汇总对应的酶与 Rhea 反应，同组内按 Entry 去重 |
| `output_terpene_compounds.tsv` | 汇总化合物名称、ChEBI 编号、SMILES、分子量等信息 |
| `output_all_nodes.tsv` | 生成图节点，并整理 ChEBI 官方 InChIKey 和由 RDKit 从 SMILES 计算的 InChIKey |

官方 InChIKey 用于化合物信息展示，派生的 InChIKey 用于匹配数据库中保存的 SMILES。两列分别保留，便于追溯结构信息的来源。

## 4. 将处理结果放到入库目录

`update_database.py` 负责把新生成的 TSV 复制到 ETL 读取的位置。这一步更新的是磁盘文件，还没有写入 MySQL。

| 目录 | 保存内容 |
| --- | --- |
| `for_enzyme_detail/` | 酶详情总表 |
| `for_enzyme_detail/child_tables/` | 名称、GO、异构体、文献、反应和序列链接子表 |
| `for_enzyme_reaction_card/` | 酶与反应的卡片汇总表 |
| `for_graph/` | 分段反应表、底物—产物对和图节点 |
| `for_compound_card/` | 化合物汇总表 |

条目级文件带来源后缀，例如 `uniprotkb_master.swiss_prot.tsv` 和 `uniprotkb_master.trembl.tsv`；跨来源汇合文件不带来源后缀。名称解析的中间表部署到项目根目录。

先查看覆盖计划：

```powershell
python update_tool/update_database.py --source=swiss_prot --dry-run
python update_tool/update_database.py --source=trembl --dry-run
python update_tool/update_database.py --merge --dry-run
```

核对文件路径、列头和行数后执行实际复制：

```powershell
python update_tool/update_database.py --source=swiss_prot
python update_tool/update_database.py --source=trembl
python update_tool/update_database.py --merge
```

脚本会在覆盖前备份旧文件，并检查空表、列头变化和异常行数收缩。部分汇总表的列数会随数据量变化，例如一个酶有多篇文献或多个反应时，会生成更多编号列，这类变化属于正常情况。

## 5. 初始化数据库

第一次建库时，在 MySQL 客户端中执行 `sql/schema.sql`。脚本创建实体表、关联表、编号映射表和查询索引。已有数据库更新数据时，不需要每次重新初始化。

```sql
SOURCE C:/sophomore/IGEM/igem_database/sql/schema.sql;
```

ETL 的连接配置位于 `etl/config.py`，通过 `IGEM_DB_HOST`、`IGEM_DB_PORT`、`IGEM_DB_USER`、`IGEM_DB_PASSWORD` 和 `IGEM_DB_NAME` 等环境变量读取。默认库名为 `igem_terpene`。

准备好连接信息后，在项目根目录执行：

```powershell
$env:IGEM_DB_PASSWORD = '实际数据库密码'
python -u etl/etl_run.py
```

`-u` 让日志及时输出，便于查看当前进度。

## 6. 执行 ETL 入库

ETL 把面向阅读和展示的宽表，转换成数据库中的实体和关联记录。执行前会保存现有边编号，再清理本次更新来源的旧数据。清理顺序是先删子表和关联记录，再删酶记录，避免外键冲突；酶编号映射表保留。

实际写入顺序如下：

### 6.1 化合物

`etl_compounds.py` 读取化合物汇总表和图节点表，写入 `compound`。

以 ChEBI ID 作为化合物标识，整理名称、SMILES、分子量、外部链接和两个 InChIKey。质量字段转换为数值，缺少名称的实体用自身编号兜底。项目配置排除的水、质子和焦磷酸等常见实体不作为图节点入库。

化合物是共享数据，采用 upsert：编号不存在时新增，已经存在时更新相应字段。

### 6.2 酶

`etl_enzymes.py` 以名称拆分表为条目基础，补充反应摘要中的信息，写入 `enzyme`。没有反应注释的酶仍然保留。

同一 accession 出现在多个来源时，按来源登记的优先级处理，当前为 Swiss-Prot 优先，并输出冲突记录。名称依次取推荐名、可用的蛋白名称和 accession，避免留下空名称。

内部 `ENZ` 编号由 `enzyme_id_map` 管理：已有条目沿用原编号，新条目领取新编号，消失条目的编号保留且不回收；重定向别名由 `enzyme_alias_map` 记录。因此更新表格的行顺序不会改变酶编号。

### 6.3 反应及参与化合物

`etl_reactions.py` 按 Rhea ID 去重，写入 `reaction`，并将反应方向统一为 `forward`、`reverse`、`reversible` 或 `unknown`。

随后拆开反应中的 ChEBI 列表，写入 `reaction_compound`，分别标记底物和产物。只有进入项目化合物集合的实体才建立关联。同一反应、化合物和角色的重复组合由唯一约束拦截。

### 6.4 酶—反应关联

`etl_edges.py` 从 Rhea 子表和底物—产物对表提取酶与反应的关系，写入 `enzyme_reaction_edge`。外部 accession 和 Rhea ID 会先映射到库内实体，再生成关联记录。

表格中的 `Rhea ID_1` 等单元格可能包含多个编号，读取时按分号拆开。`Enzyme_1…N` 等列按实际列头识别，避免固定列数造成关系遗漏。已有的关联沿用之前保存的边编号。

### 6.5 酶详情与子表

`etl_master.py` 从总表和相关子表补充蛋白序列、长度等信息，并分别写入：

- `gene`：基因信息。
- `gene_sequence_link`：核酸和蛋白序列的外部链接。
- `evidence`：参考文献和相关证据。
- `enzyme_go`：GO 注释。
- `enzyme_isoform`：异构体与序列。
- `enzyme_solubility_score`：可用的可溶性评分。

原表中横向展开的文献、序列链接等编号列，在数据库中拆成多行记录。空值按字段要求清理，整数类字段进行类型转换，重复信息在整理后写入。

### 6.6 搜索索引

`etl_search_index.py` 最后汇总名称、编号、功能描述、反应、化合物、GO、文献和序列链接等可检索字段，写入 `search_index`。

每条索引记录保留实体、关联酶、来源文件、字段名、字段值和权重。索引按批次生成并写入，以控制内存占用；数据库中的字段前缀索引用于加快关键词查询。

## 7. 入库后的检查

所有步骤完成后，日志应出现 `ETL complete`。随后在目标数据库中检查主要表的记录数：

```sql
SELECT 'enzyme' AS table_name, COUNT(*) AS row_count FROM enzyme
UNION ALL SELECT 'compound', COUNT(*) FROM compound
UNION ALL SELECT 'reaction', COUNT(*) FROM reaction
UNION ALL SELECT 'enzyme_reaction_edge', COUNT(*) FROM enzyme_reaction_edge
UNION ALL SELECT 'search_index', COUNT(*) FROM search_index;

SELECT source_type, COUNT(*) FROM enzyme GROUP BY source_type;
```

记录数需要与本次输入和处理日志对照，不能直接套用历史统计。重点确认两个来源都已写入、酶条目没有因缺少反应而丢失、关联表没有明显少边、搜索索引已经生成。

最后从网页抽查几个已知条目：搜索名称或 accession，核对酶详情中的序列和文献，查看对应反应及化合物能否在图谱中展开。行数正确只能说明数据规模合理，条目抽查才能确认字段和关联也能正常使用。

## 8. 更新与失败后重跑（AI写的，我不认为有保留的必要）

日常更新可以只替换一个来源，例如：

```powershell
python -u etl/etl_run.py --source=trembl
```

运行前仍需生成并部署该来源的新表格，以及依赖全部来源的汇合表。单来源模式会替换该来源的酶及子表；化合物仍读取共享汇合表。共享反应在单来源模式下只新增、不覆盖已有属性，属性更新由全量 ETL 负责。

当前清理和写入没有包在同一个总事务中。中途失败时，目标来源可能处于只写入部分数据的状态。修复错误后应重新执行同一条 ETL 命令，由入口统一清理并重新写入，不建议随意跳过步骤或单独执行某个入库模块。

这套流程保留了原始表、处理中间表、部署文件和数据库记录几个层次。出现字段缺失或关联错误时，可以沿着对应脚本逐步检查，定位问题发生在原始数据、表格整理还是入库阶段。
