import base64
import json
from dataclasses import dataclass

import httpx
from pydantic import ValidationError

from app.config import settings
from app.schemas import DesignConstraintModule, DesignDirectionsPayload, DesignSystemPayload, ProjectUnderstandingPayload


class AiGatewayError(RuntimeError):
    pass


@dataclass(frozen=True)
class ImageInput:
    media_type: str
    content: bytes

    def as_data_url(self) -> str:
        encoded = base64.b64encode(self.content).decode("ascii")
        return f"data:{self.media_type};base64,{encoded}"


PROJECT_UNDERSTANDING_PROMPT = """你是室内设计师的项目理解助手。根据设计 Brief 和上传的平面图，生成一份可编辑的项目理解草稿。

严格要求：
- 不输出置信度、风险等级或任何自我判断状态；
- 不虚构承重墙、尺寸、朝向或未在资料中出现的结构事实；
- 不建议拆墙、扩建或调整门窗；
- 空间关系必须服务于后续室内设计方向，而不是施工图；
- `designer_discussion_points` 只写设计师需要自行判断或补充的问题，不能把它们表述成确定事实；
- 只返回符合指定 JSON Schema 的内容，不要 Markdown 或额外说明。
"""

DESIGN_DIRECTIONS_PROMPT = """你是室内设计师的设计方向助手。根据已确认的项目理解、原始户型图和设计师参考图，生成一组可比较的三张设计方向卡。

严格要求：
- 只输出符合指定 JSON Schema 的 JSON，不要 Markdown 或额外说明；
- 三张卡必须是三种不同的空间组织策略和生活方式取舍，不是同一方案换三种风格；
- 所有方向必须保留原始户型的墙体、门窗、开口、尺寸和主要动线，不得建议拆墙、扩建、改动门窗或新增开口；
- 参考图只影响色彩、材料、家具、灯光和氛围语言，不得改变空间事实；
- 材料、家具和灯光只写设计语言，不得虚构品牌、型号、价格或资产 ID；
- 不输出置信度、风险等级或任何自我判断状态；
- `risks_and_questions` 只写设计师需要判断或补充的问题，不得写成确定事实；
- `cards` 必须恰好包含三张卡，`direction_id` 依次固定为 `direction_1`、`direction_2`、`direction_3`；
- 每张卡都必须提供：3-5 条 `spatial_strategies`、2-3 条 `key_tradeoffs`、3-6 条 `materials_and_colors`、3-6 条 `furniture_and_lighting`、1-2 条 `lifestyle_fit`、1-3 条 `risks_and_questions`、2-3 条 `distinctions`；
- 每张卡的内容要简洁，严格遵守 Schema 的字段长度和条目数量。
"""

DESIGN_SYSTEM_PROMPT = """你是室内设计团队的方案约束整理助手。根据已确认的设计方向、来源图纸和参考图，生成一份家装方案约束草稿。

严格要求：
- 只输出符合指定 JSON Schema 的 JSON，不要 Markdown 或额外说明；
- 这是设计师的执行依据，不是客户提案、效果图提示词或施工图；
- 必须包含八个模块：geometry_boundaries、spatial_organization、circulation_relationships、function_storage、materials_colors、furniture_lighting、budget_implementation、open_questions；
- 每个模块提供 2-5 条简洁约束；另提供 2-5 条 prohibited_items；
- 每条约束必须标注 source_kind（source_fact / design_decision / designer_added）、source_ref 和 strength（hard / soft / unresolved）；
- 任何不确定、方向与项目事实冲突或需要设计师决定的内容必须使用 unresolved，不得静默裁决；
- 不得修改或建议修改墙体、门窗、楼梯、管线、开口、面积或主要动线；只能引用并解释来源几何；
- 必须明确写出不可接受的做法，但禁止项也不能虚构项目事实；
- language 跟随输入 Brief、项目理解和设计方向中的主要语言；
- 不输出置信度、风险等级或自我判断状态；
- 所有 constraint_id 和 conflict_id 使用小写字母、数字、下划线或短横线；
"""

DESIGN_SYSTEM_MODULE_PROMPT = """你是室内设计团队的方案约束整理助手。请只重新生成指定的一个方案约束模块。

严格要求：
- 只输出符合指定 JSON Schema 的 JSON，不要 Markdown 或额外说明；
- 必须保持 module_id 与请求模块一致；
- 只重写当前模块，不改变来源图纸几何；
- 保留已确认方案约束包中的硬约束、禁止项和项目事实；
- `constraint_id` 不得与当前模块之外的任意约束或禁止项重复；
- 语言必须与现有方案约束包的 language 一致；
- 任何需要设计师裁决的内容使用 unresolved，不得静默裁决；
- 不输出置信度、风险等级或任何自我判断状态；
"""


class GrokVisionClient:
    def generate_project_understanding(
        self, brief: dict, images: list[ImageInput]
    ) -> ProjectUnderstandingPayload:
        if not settings.ai_api_key:
            raise AiGatewayError("未配置 AI_API_KEY，无法生成项目理解")
        if not images:
            raise AiGatewayError("项目理解需要至少一张 PNG 或 JPG 户型图")

        content: list[dict] = [
            {
                "type": "input_text",
                "text": f"{PROJECT_UNDERSTANDING_PROMPT}\n\n设计 Brief：\n{json.dumps(brief, ensure_ascii=False)}",
            }
        ]
        content.extend({"type": "input_image", "image_url": image.as_data_url()} for image in images)
        payload = {
            "model": settings.ai_model,
            "input": [{"role": "user", "content": content}],
            "reasoning": {"effort": settings.ai_reasoning_effort},
            "stream": True,
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "project_understanding",
                    "strict": True,
                    "schema": ProjectUnderstandingPayload.model_json_schema(),
                }
            },
        }
        headers = {"Authorization": f"Bearer {settings.ai_api_key}"}
        try:
            output_text = request_output_text(payload, headers)
            return ProjectUnderstandingPayload.model_validate_json(output_text)
        except (ValueError, json.JSONDecodeError, ValidationError) as error:
            raise AiGatewayError("模型未返回符合项目理解结构的内容") from error

    def generate_design_directions(
        self, understanding: dict, images: list[ImageInput]
    ) -> DesignDirectionsPayload:
        if not settings.ai_api_key:
            raise AiGatewayError("未配置 AI_API_KEY，无法生成设计方向")
        if not images:
            raise AiGatewayError("设计方向需要至少一张户型图或参考图")

        content: list[dict] = [
            {
                "type": "input_text",
                "text": (
                    f"{DESIGN_DIRECTIONS_PROMPT}\n\n"
                    f"用户主要工作语言：{infer_working_language(understanding)}。"
                    "所有标题、概念、策略、取舍、材料、生活方式和问题都必须使用该语言；"
                    "只有 direction_id 等结构化 ID 保持 ASCII。\n\n"
                    f"已确认的项目理解：\n{json.dumps(understanding, ensure_ascii=False)}"
                ),
            }
        ]
        content.extend({"type": "input_image", "image_url": image.as_data_url()} for image in images)
        payload = {
            "model": settings.ai_model,
            "input": [{"role": "user", "content": content}],
            "reasoning": {"effort": settings.ai_reasoning_effort},
            "stream": True,
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "design_directions",
                    "strict": True,
                    "schema": DesignDirectionsPayload.model_json_schema(),
                }
            },
        }
        headers = {"Authorization": f"Bearer {settings.ai_api_key}"}
        try:
            output_text = request_output_text(payload, headers)
            return DesignDirectionsPayload.model_validate(normalize_design_directions_output(output_text))
        except (ValueError, json.JSONDecodeError, ValidationError) as error:
            if isinstance(error, ValidationError):
                first_error = error.errors()[0]
                reason = f"{'.'.join(str(item) for item in first_error['loc'])}: {first_error['msg']}"
                raise AiGatewayError(f"模型未返回符合设计方向结构的内容 ({reason})") from error
            raise AiGatewayError("模型未返回符合设计方向结构的内容") from error
    def generate_design_system(
        self, direction: dict, project_context: dict, images: list[ImageInput]
    ) -> DesignSystemPayload:
        if not settings.ai_api_key:
            raise AiGatewayError("未配置 AI_API_KEY，无法生成方案约束")
        if not images:
            raise AiGatewayError("方案约束需要至少一张户型图或参考图")

        content: list[dict] = [
            {
                "type": "input_text",
                "text": (
                    f"{DESIGN_SYSTEM_PROMPT}\n\n"
                    f"用户主要工作语言：{infer_working_language(project_context.get('brief', {}))}\n\n"
                    f"设计 Brief：\n{json.dumps(project_context.get('brief', {}), ensure_ascii=False)}\n\n"
                    f"已确认项目理解：\n{json.dumps(project_context.get('project_understanding', {}), ensure_ascii=False)}\n\n"
                    f"已确认的设计方向：\n{json.dumps(direction, ensure_ascii=False)}"
                ),
            }
        ]
        content.extend({"type": "input_image", "image_url": image.as_data_url()} for image in images)
        payload = {
            "model": settings.ai_model,
            "input": [{"role": "user", "content": content}],
            "reasoning": {"effort": settings.ai_reasoning_effort},
            "stream": True,
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "design_system",
                    "strict": True,
                    "schema": DesignSystemPayload.model_json_schema(),
                }
            },
        }
        headers = {"Authorization": f"Bearer {settings.ai_api_key}"}
        try:
            output_text = request_output_text(payload, headers)
            return DesignSystemPayload.model_validate(normalize_design_system_output(output_text))
        except (ValueError, json.JSONDecodeError, ValidationError) as error:
            if isinstance(error, ValidationError):
                first_error = error.errors()[0]
                reason = f"{'.'.join(str(item) for item in first_error['loc'])}: {first_error['msg']}"
                raise AiGatewayError(f"模型未返回符合方案约束结构的内容 ({reason})") from error
            raise AiGatewayError("模型未返回符合方案约束结构的内容") from error

    def generate_design_system_module(
        self, design_system: dict, module_id: str, images: list[ImageInput]
    ) -> DesignConstraintModule:
        if not settings.ai_api_key:
            raise AiGatewayError("未配置 AI_API_KEY，无法重新生成方案约束模块")
        if not images:
            raise AiGatewayError("重新生成方案约束模块需要至少一张户型图或参考图")
        content: list[dict] = [
            {
                "type": "input_text",
                "text": (
                    f"{DESIGN_SYSTEM_MODULE_PROMPT}\n\n"
                    f"请求模块：{module_id}\n\n"
                    f"现有方案约束包：\n{json.dumps(design_system, ensure_ascii=False)}"
                ),
            }
        ]
        content.extend({"type": "input_image", "image_url": image.as_data_url()} for image in images)
        payload = {
            "model": settings.ai_model,
            "input": [{"role": "user", "content": content}],
            "reasoning": {"effort": settings.ai_reasoning_effort},
            "stream": True,
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "design_system_module",
                    "strict": True,
                    "schema": DesignConstraintModule.model_json_schema(),
                }
            },
        }
        headers = {"Authorization": f"Bearer {settings.ai_api_key}"}
        try:
            output_text = request_output_text(payload, headers)
            module = DesignConstraintModule.model_validate(json.loads(output_text))
            if module.module_id != module_id:
                raise ValueError("模型返回了错误的约束模块")
            return module
        except (ValueError, json.JSONDecodeError, ValidationError) as error:
            raise AiGatewayError("模型未返回符合方案约束模块结构的内容") from error


def normalize_design_directions_output(output_text: str) -> dict:
    payload = json.loads(output_text)
    card_text_limits = {
        "direction_id": 40,
        "title": 20,
        "concept": 80,
    }
    list_text_limits = {
        "spatial_strategies": 240,
        "key_tradeoffs": 240,
        "materials_and_colors": 120,
        "furniture_and_lighting": 160,
        "lifestyle_fit": 200,
        "risks_and_questions": 240,
        "distinctions": 240,
    }
    for card in payload.get("cards", []):
        if not isinstance(card, dict):
            continue
        for field, limit in card_text_limits.items():
            if isinstance(card.get(field), str):
                card[field] = card[field][:limit].rstrip(" ，、；;。.")
        for field, limit in list_text_limits.items():
            if isinstance(card.get(field), list):
                card[field] = [
                    item[:limit].rstrip(" ，、；;。.") if isinstance(item, str) else item
                    for item in card[field]
                ]
    return payload


def normalize_design_system_output(output_text: str) -> dict:
    payload = json.loads(output_text)
    for module in payload.get("modules", []):
        if not isinstance(module, dict):
            continue
        for field, limit in (("title", 80), ("summary", 300)):
            if isinstance(module.get(field), str):
                module[field] = module[field][:limit].rstrip(" ，、；;。.")
        for item in module.get("items", []):
            if isinstance(item, dict):
                for field, limit in (("text", 500), ("source_ref", 200)):
                    if isinstance(item.get(field), str):
                        item[field] = item[field][:limit].rstrip(" ，、；;。.")
    for item in payload.get("prohibited_items", []):
        if isinstance(item, dict):
            for field, limit in (("text", 500), ("source_ref", 200)):
                if isinstance(item.get(field), str):
                    item[field] = item[field][:limit].rstrip(" ，、；;。.")
    for conflict in payload.get("conflicts", []):
        if isinstance(conflict, dict):
            for field, limit in (("text", 500), ("resolution", 500)):
                if isinstance(conflict.get(field), str):
                    conflict[field] = conflict[field][:limit].rstrip(" ，、；;。.")
    return payload


def infer_working_language(brief: dict) -> str:
    text = json.dumps(brief, ensure_ascii=False)
    cjk_count = sum("\u4e00" <= char <= "\u9fff" for char in text)
    latin_count = sum(char.isascii() and char.isalpha() for char in text)
    return "zh-CN" if cjk_count >= latin_count else "en"


def extract_output_text(response_body: dict) -> str:
    direct_output = response_body.get("output_text")
    if isinstance(direct_output, str) and direct_output:
        return direct_output

    for output in response_body.get("output", []):
        for content in output.get("content", []):
            if content.get("type") == "output_text" and isinstance(content.get("text"), str):
                return content["text"]

    choices = response_body.get("choices", [])
    if choices:
        content = choices[0].get("message", {}).get("content")
        if isinstance(content, str) and content:
            return content
    raise ValueError("response did not include text output")


def request_output_text(payload: dict, headers: dict[str, str]) -> str:
    try:
        with httpx.stream(
            "POST",
            f"{settings.ai_base_url.rstrip('/')}/responses",
            headers=headers,
            json=payload,
            timeout=settings.ai_request_timeout_seconds,
        ) as response:
            response.raise_for_status()
            content_type = response.headers.get("content-type", "")
            if "text/event-stream" not in content_type:
                return extract_output_text(json.loads(response.read()))
            return extract_stream_output_text(response.iter_lines())
    except httpx.HTTPStatusError as error:
        raise AiGatewayError(f"模型服务返回 HTTP {error.response.status_code}") from error
    except httpx.HTTPError as error:
        raise AiGatewayError(f"模型服务连接失败: {error.__class__.__name__}") from error


def extract_stream_output_text(lines) -> str:
    deltas: list[str] = []
    completed_response: dict | None = None
    for line in lines:
        if not line.startswith("data:"):
            continue
        event_data = line.removeprefix("data:").strip()
        if not event_data or event_data == "[DONE]":
            continue
        event = json.loads(event_data)
        if event.get("type") == "response.output_text.delta":
            deltas.append(event.get("delta", ""))
        elif event.get("type") == "response.completed":
            completed_response = event.get("response")
    if deltas:
        return "".join(deltas)
    if completed_response:
        return extract_output_text(completed_response)
    raise ValueError("stream did not include text output")
