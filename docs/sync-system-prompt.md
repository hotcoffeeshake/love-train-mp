# 同步 system-prompt

`container/src/system-prompt.ts` 的内容必须与 `love-train/lib/system-prompt.ts` 保持一致。

## 步骤

1. 在 love-train 仓库 `git log lib/system-prompt.ts` 找最新 commit sha
2. 复制 `lib/system-prompt.ts` 的全部导出内容到 `container/src/system-prompt.ts`
3. 更新文件头注释的 commit sha 和日期
4. 提交：`git commit -m "chore: sync system-prompt from love-train @ <sha>"`

## 约定

- 不做 git submodule / npm link，手动 copy 最稳
- 不在 CI 里做自动同步（容易漂移）
- 每次网页版改 prompt，记得 copy 过来
