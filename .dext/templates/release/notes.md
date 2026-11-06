---
dext-template:
  format: markdown
  title: 文档标题，调用方已给定，原样使用
  summary_en: 2-4 句英文，说明本版最重要的事
  highlights_en:
    type: lines
    description: 英文，最多 3 条，写升级者最该知道的结论
  breaking_en:
    type: lines
    description: 英文，每行一条 `**变化** — 可执行的迁移动作`；写不出迁移动作的不要写进来
  features_en:
    type: lines
    description: 英文，净新增且用户可感知的能力
  fixes_en:
    type: lines
    description: 英文，修好的用户可感知缺陷
  notes_en:
    type: lines
    description: 英文，其他用户可感知的影响，例如性能、兼容性、已知问题
  summary_zh: 2-4 句简体中文，与 summary_en 说同一件事
  highlights_zh:
    type: lines
    description: 简体中文，与 highlights_en 一一对应
  breaking_zh:
    type: lines
    description: 简体中文，每行一条 `**变化** — 可执行的迁移动作`，与 breaking_en 一一对应
  features_zh:
    type: lines
    description: 简体中文，与 features_en 一一对应
  fixes_zh:
    type: lines
    description: 简体中文，与 fixes_en 一一对应
  notes_zh:
    type: lines
    description: 简体中文，与 notes_en 一一对应
---
# {{title}}

{{summary_en}}

## ✨ Highlights

- {{highlights_en}}

## 💥 Breaking changes

- {{breaking_en}}

## 🚀 New features

- {{features_en}}

## 🐛 Fixes

- {{fixes_en}}

## 📝 Notes

- {{notes_en}}

---

{{summary_zh}}

## ✨ 亮点

- {{highlights_zh}}

## 💥 破坏性变更

- {{breaking_zh}}

## 🚀 新功能

- {{features_zh}}

## 🐛 修复

- {{fixes_zh}}

## 📝 其他说明

- {{notes_zh}}
