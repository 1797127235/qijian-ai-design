import { z } from "zod";
import { HttpError } from "../../lib/errors.js";

export async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) throw new HttpError(422, parsed.error.issues.map((issue) => issue.message).join("; "));
  return parsed.data;
}
