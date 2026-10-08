import { describe, expect, it } from "vitest";
import { applyReasoning } from "../adapters/providers/anthropic-pass";

/**
 * Regression cover for a 400 observed on the wire 2026-08-17:
 *
 *   [ccx] REQUEST: model="housekeeping" -> provider="anthropic"
 *         model="claude-haiku-4-5" in:think=unset,effort=high
 *   [ccx] ERROR: Upstream error (400): "This model does not support the
 *         effort parameter."
 *
 * `housekeeping` is an unsuffixed alias, so applyReasoning took the `skip`
 * branch and forwarded the client's frontmatter effort into a model on which
 * the field is documented as an error.
 *
 * The cases below deliberately include the ones that must NOT be touched. A
 * test that only asserted "effort is gone" would pass just as well against a
 * version that stripped effort from everything, which would break Sonnet 5 --
 * where the field is the supported form.
 */
describe("applyReasoning: effort sanitisation on the skip path", () => {
  const withEffort = () => ({ output_config: { effort: "high" } });

  it("strips effort for a budget-family model when there is no suffix", () => {
    const body: any = withEffort();
    const note = applyReasoning(body, "claude-haiku-4-5", undefined);
    expect(body.output_config).toBeUndefined();
    expect(note).toMatch(/stripped/);
  });

  it("leaves effort alone for an effort-family model", () => {
    const body: any = withEffort();
    applyReasoning(body, "claude-sonnet-5", undefined);
    expect(body.output_config).toEqual({ effort: "high" });
  });

  it("leaves an unknown model untouched rather than guessing", () => {
    const body: any = withEffort();
    applyReasoning(body, "claude-something-9", undefined);
    expect(body.output_config).toEqual({ effort: "high" });
  });

  it("keeps other output_config keys and drops only effort", () => {
    const body: any = { output_config: { effort: "high", other: 1 } };
    applyReasoning(body, "claude-haiku-4-5", undefined);
    expect(body.output_config).toEqual({ other: 1 });
  });

  it("is a no-op when the client sent no effort at all", () => {
    const body: any = {};
    const note = applyReasoning(body, "claude-haiku-4-5", undefined);
    expect(note).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });

  it("still strips effort on the suffixed budget path", () => {
    const body: any = { ...withEffort(), max_tokens: 8192 };
    applyReasoning(body, "claude-haiku-4-5", "low" as any);
    expect(body.output_config).toBeUndefined();
    expect(body.thinking?.type).toBe("enabled");
  });

  // Haiku 5.5 (verified live 2026-10-07: output_config.effort accepted, max thinks, low
  // does not) is effort-family, unlike haiku-4-5 -- before this it fell to `skip` and the
  // @suffix was silently ignored.
  it("routes claude-haiku-5-5 to effort, not the haiku-4-5 budget path", () => {
    const body: any = { max_tokens: 8192 };
    applyReasoning(body, "claude-haiku-5-5", "max" as any);
    expect(body.output_config).toEqual({ effort: "max" });
    expect(body.thinking?.budget_tokens).toBeUndefined();
  });
});
