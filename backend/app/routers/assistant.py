import json
import re
from typing import Literal

import httpx
from fastapi import APIRouter, Depends
from pydantic import Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.deps import get_db
from app.schemas.common import ApiResponse, CamelModel
from app.services.entity_service import load_enzyme_detail
from app.services.graph_service import suggest_displayable_compounds
from app.services.pathway_service import PathwayInputError, search_pathways
from app.services.search_service import search_enzyme_table


router = APIRouter()


class AskRequest(CamelModel):
    question: str = Field(min_length=2, max_length=500)
    enzyme_id: str | None = None
    source_types: list[str] = []
    language: Literal["zh", "en"] = "zh"


def pathway_tokens(question: str) -> tuple[str, str] | None:
    match = re.search(r"(?:从|from)\s*([A-Za-z0-9_:.\-]+)\s*(?:到|至|to|→|->)\s*([A-Za-z0-9_:.\-]+)", question, re.I)
    if match:
        return match.group(1), match.group(2)
    return None


def search_term(question: str) -> str:
    identifier = re.search(r"\b(?:ENZ\d+|CHEBI:\d+|EC\s*\d+(?:\.\d+){1,3}|[A-Z][0-9][A-Z0-9]{4,8})\b", question, re.I)
    if identifier:
        return identifier.group().strip()
    quoted = re.search(r"[“\"']([^”\"']{2,80})[”\"']", question)
    if quoted:
        return quoted.group(1).strip()
    cleaned = re.sub(r"^(请|帮我|能否|可以|我想|查找|查一下|搜索|找找|找|关于|请问|有哪些|有没有|介绍一下|介绍|what is|find|search for)\s*", "", question.strip(), flags=re.I)
    cleaned = re.sub(r"(的?酶|的?化合物|的?反应|的?通路|是什么|有哪些|有没有|相关信息|相关记录|的信息|吗|呢|？|\?|。)$", "", cleaned).strip()
    return cleaned[:80]


def enzyme_facts(detail) -> dict:
    return {
        "id": detail.enzyme_id,
        "name": detail.primary_name,
        "uniprot": detail.uniprot_id,
        "organism": detail.organism_name,
        "gene": detail.gene.gene_name if detail.gene else None,
        "source": detail.source_type,
        "review": detail.review_status,
        "length": detail.length,
        "deepSolnetScore": detail.deep_solnet_score,
        "membrane": detail.membrane,
        "reactions": [
            {
                "id": reaction.reaction_id,
                "equation": reaction.equation,
                "ec": reaction.ec_number,
                "substrates": [item.name for item in reaction.substrates],
                "products": [item.name for item in reaction.products],
            }
            for reaction in detail.reactions[:12]
        ],
        "goTerms": [term.go_term for term in detail.go_terms[:8]],
        "evidenceCount": len(detail.evidence),
    }


def database_answer(question: str, facts: dict, language: str) -> str:
    detail = facts["currentEnzyme"]
    hits = facts["enzymeHits"]
    compounds = facts["compoundHits"]
    topic = (
        "score" if re.search(r"分数|评分|score|solubility", question, re.I)
        else "gene" if re.search(r"基因|gene", question, re.I)
        else "sequence" if re.search(r"序列|sequence|长度|length", question, re.I)
        else "evidence" if re.search(r"文献|证据|reference|evidence|paper", question, re.I)
        else "organism" if re.search(r"物种|来源物种|organism|species", question, re.I)
        else "reaction"
    )
    if language == "en":
        if facts["pathway"]:
            return f"Found {facts['pathway']['total']} pathways from {facts['pathway']['start']} to {facts['pathway']['end']}. Open the graph to inspect the routes."
        if detail:
            if topic == "score":
                return f"{detail['name']}: DeepSolNet reference score {detail['deepSolnetScore']:.3f}." if detail["deepSolnetScore"] is not None else "No DeepSolNet score is recorded for this enzyme."
            if topic == "gene":
                return f"Recorded gene: {detail['gene']}." if detail["gene"] else "No gene name is recorded for this enzyme."
            if topic == "sequence":
                return f"Recorded protein length: {detail['length']} amino acids." if detail["length"] else "No protein length is recorded for this enzyme."
            if topic == "evidence":
                return f"This record has {detail['evidenceCount']} evidence entries. Open the References section for citations."
            if topic == "organism":
                return f"Recorded organism: {detail['organism']}." if detail["organism"] else "No organism is recorded for this enzyme."
            if detail["reactions"]:
                return f"{detail['name']} has {len(detail['reactions'])} shown reactions: " + "; ".join(item["equation"] for item in detail["reactions"][:3]) + "."
            return "No reaction is recorded for this enzyme."
        if hits:
            return f"Found {facts['enzymeTotal']} matching enzymes. Open a record below or view all results."
        if compounds:
            return f"Found {len(compounds)} matching compounds. Open one in the graph below."
        return "No matching record found. Try an enzyme name, UniProt ID, EC number, or compound name. For pathways, ask “from CHEBI:… to CHEBI:…”."
    if facts["pathway"]:
        return f"从 {facts['pathway']['start']} 到 {facts['pathway']['end']} 检索到 {facts['pathway']['total']} 条通路，可打开图谱查看。"
    if detail:
        if topic == "score":
            return f"{detail['name']} 的 DeepSolNet 模型参考分为 {detail['deepSolnetScore']:.3f}。" if detail["deepSolnetScore"] is not None else "这条酶记录没有 DeepSolNet 分数。"
        if topic == "gene":
            return f"记录的基因名：{detail['gene']}。" if detail["gene"] else "这条酶记录没有基因名。"
        if topic == "sequence":
            return f"记录的蛋白质长度：{detail['length']} 个氨基酸。" if detail["length"] else "这条酶记录没有蛋白质长度。"
        if topic == "evidence":
            return f"这条酶记录有 {detail['evidenceCount']} 条文献证据；可打开详情页的 References 分区查看。"
        if topic == "organism":
            return f"记录的物种：{detail['organism']}。" if detail["organism"] else "这条酶记录没有物种信息。"
        if detail["reactions"]:
            return f"{detail['name']} 的反应包括：" + "；".join(item["equation"] for item in detail["reactions"][:3]) + "。"
        return "这条酶记录没有反应信息。"
    if hits:
        return f"检索到 {facts['enzymeTotal']} 条匹配酶记录，下面列出前 {len(hits)} 条。"
    if compounds:
        return f"找到 {len(compounds)} 个匹配的化合物，点击可在图谱中定位。"
    return "数据库中没有找到匹配记录。可以换用酶名、UniProt ID、EC 编号或化合物名称；通路可问“从 CHEBI:… 到 CHEBI:…”。"


async def model_answer(question: str, facts: dict, language: str) -> str | None:
    if not settings.assistant_api_key:
        return None
    instructions = (
        "Answer questions about Terpene Atlas using only the supplied JSON facts. "
        "Never invent records, pathways, scores, citations or scientific conclusions. "
        "If facts are insufficient, say so and suggest opening search. "
        "DeepSolNet is a model reference score, not a solubility label or calibrated probability. "
        "Be concise. Reply in Chinese when language is zh, otherwise English."
    )
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(
                "https://api.openai.com/v1/responses",
                headers={"Authorization": f"Bearer {settings.assistant_api_key}"},
                json={
                    "model": settings.assistant_model,
                    "instructions": instructions,
                    "input": [{"role": "user", "content": json.dumps({"language": language, "question": question, "facts": facts}, ensure_ascii=False)}],
                    "max_output_tokens": 450,
                },
            )
            response.raise_for_status()
            payload = response.json()
            answer = "".join(
                part.get("text", "")
                for item in payload.get("output", [])
                for part in item.get("content", [])
                if part.get("type") == "output_text"
            ).strip()
            return answer or None
    except (httpx.HTTPError, ValueError, KeyError):
        return None


@router.post("/assistant/ask")
async def ask_assistant(request: AskRequest, db: AsyncSession = Depends(get_db)):
    question = request.question.strip()
    endpoints = pathway_tokens(question)
    pathway = None
    if endpoints:
        try:
            cards, _, total = await search_pathways(
                db,
                start_compound_id=endpoints[0],
                end_compound_id=endpoints[1],
                source_types=request.source_types,
                limit=3,
            )
            pathway = {
                "start": endpoints[0],
                "end": endpoints[1],
                "total": total,
                "routes": [{"summary": card.summary, "steps": card.step_count} for card in cards],
            }
        except PathwayInputError as error:
            message = error.message if request.language == "zh" else "The pathway endpoints could not be resolved."
            return ApiResponse(data={"answer": message, "mode": "database", "references": [], "searchQuery": "", "enzymeTotal": 0, "pathway": None})
    term = search_term(question)
    use_current = bool(request.enzyme_id and re.search(r"这个酶|当前酶|它|this enzyme|current enzyme|催化|序列|文献|score|分数|物种|基因|反应|酶的|its\b", question, re.I))
    detail = await load_enzyme_detail(db, request.enzyme_id) if use_current else None
    if use_current:
        term = ""
    if endpoints:
        detail = None
        term = ""
    enzyme_hits, enzyme_total = await search_enzyme_table(db, q=term, source_types=request.source_types, limit=5) if term else ([], 0)
    compound_hits = await suggest_displayable_compounds(db, q=term, limit=4) if term else []
    facts = {
        "currentEnzyme": enzyme_facts(detail) if detail else None,
        "enzymeTotal": enzyme_total,
        "enzymeHits": [{"id": hit.enzyme_id, "name": hit.primary_name, "organism": hit.organism_name, "ec": hit.ec_numbers} for hit in enzyme_hits],
        "compoundHits": [{"id": hit.compound_id, "name": hit.name} for hit in compound_hits],
        "pathway": pathway,
    }
    references = []
    if detail:
        references.append({"kind": "enzyme", "id": detail.enzyme_id, "label": detail.primary_name})
    references.extend({"kind": "enzyme", "id": hit.enzyme_id, "label": hit.primary_name} for hit in enzyme_hits if not detail or hit.enzyme_id != detail.enzyme_id)
    references.extend({"kind": "compound", "id": hit.compound_id, "label": hit.name} for hit in compound_hits)
    generated = await model_answer(question, facts, request.language)
    return ApiResponse(data={
        "answer": generated or database_answer(question, facts, request.language),
        "mode": "ai" if generated else "database",
        "references": references,
        "searchQuery": term,
        "enzymeTotal": enzyme_total,
        "pathway": {"start": endpoints[0], "end": endpoints[1]} if pathway else None,
    })
