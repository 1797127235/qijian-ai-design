import uuid
from unittest.mock import Mock

import pytest
from pydantic import ValidationError

from app.models import Artifact, ArtifactVersion
from app.schemas import (
    DesignBriefPayload,
    DesignConstraintConflict,
    DesignConstraintModule,
    DesignDirectionsPayload,
    DesignSystemModuleCandidatePayload,
    ProjectUnderstandingPayload,
    ProposalCanvasPayload,
    SpaceMapCreate,
    SpaceMapPayload,
)
from app.services import canonical_hash, validate_file_refs


def test_design_brief_requires_a_design_need() -> None:
    with pytest.raises(ValidationError):
        DesignBriefPayload(needs="")


def test_artifact_resolves_current_version_without_mutating_history() -> None:
    first = ArtifactVersion(id=uuid.uuid4(), version=1, payload={}, input_refs=[])
    second = ArtifactVersion(id=uuid.uuid4(), version=2, payload={}, input_refs=[])
    artifact = Artifact(current_version_id=second.id, versions=[first, second])

    assert artifact.current_version is second
    assert [version.version for version in artifact.versions] == [1, 2]


def test_content_hash_is_stable_for_equivalent_json() -> None:
    first = canonical_hash({"needs": "增加收纳", "style": "温暖"}, [])
    second = canonical_hash({"style": "温暖", "needs": "增加收纳"}, [])

    assert first == second


def test_file_reference_validation_queries_owned_files() -> None:
    db = Mock()
    db.scalar.return_value = 1
    file_id = uuid.uuid4()

    validate_file_refs(
        db,
        project_id=uuid.uuid4(),
        owner_id=uuid.uuid4(),
        input_refs=[{"file_id": str(file_id), "role": "floor_plan"}],
    )

    db.scalar.assert_called_once()


def test_project_understanding_requires_all_four_editable_sections() -> None:
    with pytest.raises(ValidationError):
        ProjectUnderstandingPayload.model_validate({"designer_discussion_points": []})

    payload = ProjectUnderstandingPayload.model_validate(
        {
            "project_and_household_summary": {
                "project_summary": "城市住宅改造",
                "household_summary": "三口之家",
            },
            "space_and_room_review": [
                {"name": "客餐厅", "proposed_use": "家庭日常活动", "relationship_notes": "连接厨房与玄关"}
            ],
            "circulation_and_opening_relationships": ["入口连接玄关与公共区"],
            "designer_discussion_points": [],
        }
    )

    assert payload.space_and_room_review[0].name == "客餐厅"


def test_design_directions_require_three_distinct_spatial_strategies() -> None:
    card = {
        "direction_id": "one",
        "title": "方向一",
        "concept": "连续的公共空间",
        "spatial_strategies": ["保持公共空间连续", "把收纳集中在入口", "让采光深入客餐厅"],
        "key_tradeoffs": ["优先家庭互动", "减少独立封闭界面"],
        "materials_and_colors": ["浅木", "暖灰", "哑光石材"],
        "furniture_and_lighting": ["低矮沙发", "线性灯", "局部阅读灯"],
        "lifestyle_fit": ["适合日常共同活动"],
        "risks_and_questions": ["确认收纳容量"],
        "distinctions": ["比其他方向更重视公共空间连续性", "牺牲部分独立性"]
    }
    valid = [card | {"direction_id": name} for name in ("one", "two", "three")]
    valid[1]["spatial_strategies"] = ["优先动静分区", "把卧室与公共区隔开", "控制视线穿透" ]
    valid[2]["spatial_strategies"] = ["建立家庭收纳带", "串联玄关餐厅书房", "让家务路径更短"]
    payload = DesignDirectionsPayload(cards=valid)
    assert payload.source_geometry_policy == "preserve_source_geometry"

    with pytest.raises(ValidationError):
        DesignDirectionsPayload(cards=[card, card | {"direction_id": "two"}, card | {"direction_id": "three"}])


def test_design_system_module_candidate_keeps_requested_module_identity() -> None:
    module = DesignConstraintModule.model_validate(
        {
            "module_id": "geometry_boundaries",
            "title": "几何边界",
            "summary": "保留原始户型边界。",
            "items": [
                {
                    "constraint_id": "geometry_1",
                    "text": "不改动墙体、门窗与开口。",
                    "source_kind": "source_fact",
                    "source_ref": "原始户型图",
                    "strength": "hard",
                    "designer_edited": False,
                }
            ],
        }
    )

    payload = DesignSystemModuleCandidatePayload(module_id="geometry_boundaries", module=module)
    assert payload.module.module_id == "geometry_boundaries"

    with pytest.raises(ValidationError):
        DesignSystemModuleCandidatePayload(module_id="open_questions", module=module)


def test_resolved_design_system_conflict_requires_a_resolution() -> None:
    with pytest.raises(ValidationError):
        DesignConstraintConflict.model_validate({
            "conflict_id": "conflict_1",
            "text": "需要确认厨房是否增加高柜。",
            "related_constraint_ids": ["storage_1"],
            "status": "resolved",
        })


def valid_space_map_payload() -> dict:
    return {
        "source_file_id": str(uuid.uuid4()),
        "upstream": {
            "design_direction_artifact_id": str(uuid.uuid4()),
            "design_direction_version_id": str(uuid.uuid4()),
            "design_system_artifact_id": str(uuid.uuid4()),
            "design_system_version_id": str(uuid.uuid4()),
        },
        "spaces": [
            {
                "space_id": "living_room",
                "name": "客餐厅",
                "use": "家庭日常活动",
                "polygon": [{"x": 0.1, "y": 0.1}, {"x": 0.8, "y": 0.1}, {"x": 0.8, "y": 0.7}],
                "is_key_space": True,
                "designer_confirmed": True,
            }
        ],
        "relationships": [],
    }


def test_space_map_rejects_degenerate_polygons_and_unknown_relations() -> None:
    degenerate = valid_space_map_payload()
    degenerate["spaces"][0]["polygon"] = [{"x": 0.1, "y": 0.1}, {"x": 0.2, "y": 0.2}, {"x": 0.3, "y": 0.3}]
    with pytest.raises(ValidationError):
        SpaceMapPayload.model_validate(degenerate)

    unknown_relation = valid_space_map_payload()
    unknown_relation["relationships"] = [{
        "relation_id": "living_to_bedroom",
        "from_space_id": "living_room",
        "to_space_id": "bedroom",
        "relation_type": "circulation",
        "note": "进入卧室的动线",
    }]
    with pytest.raises(ValidationError):
        SpaceMapPayload.model_validate(unknown_relation)


def test_confirmed_space_map_requires_designer_confirmation_for_every_region() -> None:
    payload = valid_space_map_payload()
    payload["spaces"][0]["designer_confirmed"] = False
    with pytest.raises(ValidationError):
        SpaceMapCreate.model_validate({"payload": payload, "status": "confirmed"})


def test_proposal_canvas_rejects_duplicate_key_spaces() -> None:
    source = valid_space_map_payload()
    with pytest.raises(ValidationError):
        ProposalCanvasPayload.model_validate({
            "title": "住宅提案",
            "space_map_artifact_id": str(uuid.uuid4()),
            "space_map_version_id": str(uuid.uuid4()),
            "upstream": source["upstream"],
            "key_space_ids": ["living_room", "living_room"],
        })
