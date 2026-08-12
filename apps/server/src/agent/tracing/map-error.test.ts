import { describe, expect, it } from "vitest";
import { mapError, mapErrorFromUnknown } from "./map-error.js";

describe("mapError", () => {
  it("maps validation", () => {
    expect(mapError({ message: "prompt 不能为空" }).error_code).toBe("VALIDATION");
    expect(mapError({ message: "未指定源物件：请用户先点选" }).error_code).toBe("VALIDATION");
  });

  it("maps source not found", () => {
    expect(mapError({ message: "源物件不存在" }).error_code).toBe("SOURCE_NOT_FOUND");
    expect(mapError({ message: "未找到 Artifact" }).error_code).toBe("SOURCE_NOT_FOUND");
  });

  it("maps provider 4xx", () => {
    expect(mapError({ message: "图服务返回错误", status: 400 }).error_code).toBe("PROVIDER_4XX");
  });

  it("maps user abort", () => {
    expect(mapError({ message: "已停止", name: "AbortError" }).error_code).toBe("USER_ABORT");
    expect(mapErrorFromUnknown(Object.assign(new Error("x"), { name: "AbortError" }), { aborted: true }).error_code)
      .toBe("USER_ABORT");
  });

  it("maps timeout and 5xx", () => {
    expect(mapError({ message: "upstream timeout" }).error_code).toBe("PROVIDER_TIMEOUT");
    expect(mapError({ message: "boom", status: 502 }).error_code).toBe("PROVIDER_5XX");
  });
});
