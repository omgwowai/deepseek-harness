// 对齐页「正在执行」行的后台任务名字（2026-10-26）：pwsh / bash 任务的 label 是命令原文，先用启动它的那次调用的
// description；没有时从命令认出常见的几种，认不出的只留程序名和关键参数（不露重定向、$LASTEXITCODE 这些尾巴）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { jobName, jobTitle } from "../job-title.js";

test("jobTitle: 常见的几种认成可读的名字", () => {
  const cases = [
    ['pwsh -NoProfile -File .\\dsh-verify.ps1 *> C:\\Users\\me\\.dsh\\tmp\\probe\\task-eta-fm\\verify-dec.log; "verify exit $LASTEXITCODE"; exit $LASTEXITCODE', "完整检查 dsh-verify"],
    ["$env:ALIGN_SKILL_DIR='D:\\fm\\skills'; pwsh -NoProfile -File C:/Users/me/.dsh-wt/x/dsh-verify.ps1 -SkipBootSmoke 2>&1 | Select-Object -Last 30", "完整检查 dsh-verify"],
    ["pwsh -NoProfile -File C:/Users/me/.dsh-wt/x/dsh-verify.ps1 -Only lib,plugins 2>&1 | Select-Object -Last 5", "检查 dsh-verify 的 lib、plugins 段"],
    ["pwsh -NoProfile -File .\\dsh-verify.ps1 -SkipRegressionTests -SkipPatchTests", "快速检查 dsh-verify"],
    ["cd D:/app; pnpm test 2>&1 | Out-File t.log", "测试 pnpm test"],
    ["npm run test:unit -- --watch=false", "测试 npm run test:unit"],
    ["node --test plugins/dsh-alignment/test/page-browser.test.mjs plugins/dsh-alignment/test/todos.test.mjs 2>&1 | Select-String '^ℹ (pass|fail)'", "测试 page-browser.test.mjs 等 2 个文件"],
    ["$env:JAVA_HOME = 'C:\\jdk17'; .\\gradlew.bat :androidApp:assembleDebug --console=plain *> build.log", "打 APK gradle assembleDebug"],
    [".\\gradlew.bat :shared:testAndroidHostTest :androidApp:testDebugUnitTest --continue *> t.log; \"EXIT=$LASTEXITCODE\"", "测试 gradle testAndroidHostTest testDebugUnitTest"],
    ["npx playwright test tests/e2e --reporter=line", "测试 playwright"],
    ["uv run python -m http.server 8765 --bind 127.0.0.1", "预览服务 http.server :8765"],
    ["Get-ChildItem env: | Where-Object Name -like 'DSH_*' | ForEach-Object { Remove-Item \"env:$($_.Name)\" }; dsh --profile web --port 3099 --no-open *> web.log", "独立 DSH 实例 :3099"],
  ];
  for (const [cmd, want] of cases) assert.equal(jobTitle(cmd), want, cmd);
});

test("jobTitle: 认不出的只留程序名和关键参数，一行，不露尾巴", () => {
  assert.equal(jobTitle("node C:/Users/me/.dsh/tmp/probe/dsh-voice/keepalive-probe.mjs *> C:/Users/me/.dsh/tmp/k.log; exit $LASTEXITCODE"), "node keepalive-probe.mjs");
  assert.equal(jobTitle("cd C:/Users/me/.dsh-wt/x; git rebase master 2>&1 | Select-Object -Last 5"), "git rebase master", "cd 这类前置语句不算");
  assert.equal(jobTitle("pwsh -NoProfile -File C:\\Users\\me\\.dsh\\tmp\\probe-full.ps1 -Runs 6"), "pwsh probe-full.ps1 -Runs 6");
  assert.equal(jobTitle('uv run --with zstandard python C:\\tools\\tv.py search "xiaoai" --json > out.json'), "python tv.py search xiaoai --json", "uv run 的 --with 带值");
  assert.equal(jobTitle("Start-Sleep -Seconds 150"), "Start-Sleep -Seconds 150");
  const long = jobTitle("web-search research \"Are there published, reproducible evaluations of Chinese tokenization choices for retrieval\" --tier deep");
  assert.equal(long.length, 60, "截断到 60 字");
  assert.ok(long.endsWith("…"));
  for (const t of [jobTitle("node a.mjs *> x.log; \"exit $LASTEXITCODE\"; exit $LASTEXITCODE"), jobTitle("node a.mjs 2>&1 | Tee-Object x.log")]) assert.doesNotMatch(t, /LASTEXITCODE|\*>|2>&1|\||Tee-Object/, t);
  assert.doesNotMatch(jobTitle("node a.mjs\nnode b.mjs"), /\n/, "一行");
  assert.equal(jobTitle("  "), null);
});

test("jobName: description 优先；pwsh / bash 带命令原文；别的种类用 label", () => {
  const cmd = "pwsh -NoProfile -File .\\dsh-verify.ps1 *> v.log; exit $LASTEXITCODE";
  assert.deepEqual(jobName("pwsh", cmd, "  dsh-verify、提交合入 master  "), { name: "dsh-verify、提交合入 master", cmd });
  assert.deepEqual(jobName("pwsh", cmd, null), { name: "完整检查 dsh-verify", cmd }, "没有 description：从命令认");
  assert.deepEqual(jobName("bash", "pnpm test", ""), { name: "测试 pnpm test", cmd: "pnpm test" });
  assert.deepEqual(jobName("workflow", "align-review", null), { name: "align-review", cmd: null }, "workflow 的 label 是 meta.name");
  assert.deepEqual(jobName("workflow", "align-review", "审一轮对齐页"), { name: "审一轮对齐页", cmd: null });
  assert.deepEqual(jobName("pwsh", null, null), { name: null, cmd: null });
});
