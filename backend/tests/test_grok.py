import json
from unittest.mock import MagicMock, Mock, patch

from app.config import settings
from app.grok import GrokVisionClient, ImageInput, extract_output_text, normalize_design_directions_output


def test_grok_client_requests_structured_project_understanding(monkeypatch) -> None:
    monkeypatch.setattr(settings, "ai_api_key", "test-key")
    response = Mock()
    response.raise_for_status.return_value = None
    response.headers = {"content-type": "application/json"}
    response.read.return_value = json.dumps({"output_text": json.dumps(
            {
                "project_and_household_summary": {
                    "project_summary": "城市住宅改造",
                    "household_summary": "三口之家",
                },
                "space_and_room_review": [
                    {
                        "name": "客餐厅",
                        "proposed_use": "日常活动中心",
                        "relationship_notes": "连接厨房与玄关",
                    }
                ],
                "circulation_and_opening_relationships": ["从玄关进入公共区"],
                "designer_discussion_points": ["确认书房的主要使用者"],
            },
            ensure_ascii=False,
        )}).encode()
    stream = MagicMock()
    stream.__enter__.return_value = response
    with patch("app.grok.httpx.stream", return_value=stream) as post:
        result = GrokVisionClient().generate_project_understanding(
            {"needs": "增加收纳"}, [ImageInput(media_type="image/png", content=b"image")]
        )

    assert result.space_and_room_review[0].name == "客餐厅"
    request_payload = post.call_args.kwargs["json"]
    assert request_payload["model"] == "grok-4.5-latest"
    assert request_payload["reasoning"]["effort"] == "low"
    assert request_payload["stream"] is True
    assert request_payload["text"]["format"]["type"] == "json_schema"
    assert request_payload["input"][0]["content"][1]["type"] == "input_image"


def test_extract_output_text_supports_standard_responses_content() -> None:
    response = {
        "output": [{"content": [{"type": "output_text", "text": '{"ok": true}'}]}]
    }

    assert extract_output_text(response) == '{"ok": true}'


def test_direction_output_normalization_only_trims_text_length() -> None:
    raw = json.dumps({"cards": [{"title": "a" * 21, "concept": "b" * 81, "spatial_strategies": ["c" * 241]}]})

    normalized = normalize_design_directions_output(raw)

    assert normalized["cards"][0]["title"] == "a" * 20
    assert normalized["cards"][0]["concept"] == "b" * 80
    assert normalized["cards"][0]["spatial_strategies"] == ["c" * 240]
