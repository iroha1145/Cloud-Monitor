import assert from "node:assert/strict";
import test from "node:test";
import { splitReleaseNotes } from "../src/release-notes";

test("release links exclude Chinese sentence punctuation without losing the prose", () => {
  for (const punctuation of ["。", "，", "）", "！", "；", "】"]) {
    const note = `详情 https://github.com/example/project${punctuation}更新完成`;
    const parts = splitReleaseNotes(note);
    assert.equal(parts[1], "https://github.com/example/project");
    assert.equal(parts.join(""), note);
  }
  assert.deepEqual(splitReleaseNotes("**更新**（https://github.com/example/project）"),
    ["更新（", "https://github.com/example/project", "）"]);
  assert.deepEqual(splitReleaseNotes("[提交](https://github.com/example/project?a=1&b=2#notes)"),
    ["[提交](", "https://github.com/example/project?a=1&b=2#notes", ")"]);
});
