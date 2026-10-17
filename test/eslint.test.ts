import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const eslint = new ESLint({ cwd });

/** Lint a snippet with the repository's real config and return the SQL-rule hits. */
async function sqlRuleMessages(code: string) {
  const [result] = await eslint.lintText(code, { filePath: "src/__lint_probe__.ts" });
  return (result?.messages ?? []).filter((m) => m.ruleId === "no-restricted-syntax");
}

describe("sql template lint rule", () => {
  test("a prepared statement with bound parameters passes", async () => {
    const messages = await sqlRuleMessages(
      'const row = db.prepare("SELECT * FROM mandates WHERE id = ?").get(1);\n',
    );
    assert.equal(messages.length, 0);
  });

  test("a deliberately string-built query fails", async () => {
    const messages = await sqlRuleMessages(
      "const row = db.prepare(`SELECT * FROM mandates WHERE id = ${id}`).get();\n",
    );
    assert.equal(messages.length, 1);
    assert.match(messages[0]?.message ?? "", /interpolated template literal/);
  });

  test("a vetted static fragment can be allowed with an explained comment", async () => {
    const messages = await sqlRuleMessages(
      [
        "// eslint-disable-next-line no-restricted-syntax -- clause is built from fixed strings",
        "const q = db.prepare(`SELECT * FROM mandates ${clause}`);",
        "",
      ].join("\n"),
    );
    assert.equal(messages.length, 0);
  });
});
