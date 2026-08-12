/**
 * 路由层共享工具。
 *  - body<T>：解析 JSON body 并按 zod schema 校验，失败抛 422
 *  - 所有路由都用这个拿 body，类型安全（schema 决定 T）
 */
import { z } from "zod";
import { HttpError } from "../../lib/errors.js";

/** 解析 + 校验 body；422 时把 zod 的所有 issue 拼成 message 给前端调试。 */
export async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) throw new HttpError(422, parsed.error.issues.map((issue) => issue.message).join("; "));
  return parsed.data;
}
