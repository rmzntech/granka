---
granka-bundled: v1
name: granka-docs
description: Работа с PDF и DOCX в granka через doc_outline/doc_read/doc_create/doc_edit/doc_format — от чтения до фирменного оформления. Используй при любой задаче с документами.
---

# Документы в granka

## Чтение

1. `doc_outline(path)` — структура: страницы, заголовки, таблицы. Всегда начинай с него.
2. `doc_read(path, from, to)` — страницы (PDF) или блоки (DOCX). Вывод ограничен,
   при обрезке будет подсказка `[дальше: doc_read(from=N)]`.
3. `doc_search(path, query)` — найти фрагмент и узнать страницу.

## Создание

`doc_create({ path, content, style })`, где `content` — markdown-lite:
`#` заголовки, `-` списки, `| a | b |` таблицы, `**жирный**`, `*курсив*`, `` `код` ``.

`style`: `font` (sans/serif/mono), `size` (pt), `lineHeight`, `margin` (см),
`accent` (hex без #), `header`, `footer` (с номерами страниц), `page` (a4/letter/a5),
`align` (left/justify).

## Оформление существующего файла

`doc_format(path, { style })` перерисовывает документ с новым стилем: текст,
заголовки, списки, таблицы и картинки сохраняются. Ручные переносы теряются —
предупреди пользователя, если это важно. Перед `doc_edit`/`doc_format` оригинал
сохраняется в `<файл>.granka-versions/` (последние 10 версий) — откат
копированием обратно.

## Точечные правки

- DOCX: `{ type: "replace", find, replace }` (ищет и через разрывы строк Word),
  `{ type: "append", content, heading }`.
- PDF: `{ type: "add_text", page, x, y, text, size }`,
  `{ type: "redact", page, x, y, width, height }` (настоящее удаление текста +
  плашка), `{ type: "add_page" }`, `{ type: "fill_form", fields }` (текст,
  чекбокс, список, radio; форма не убивается), `{ type: "merge", sources }`,
  `{ type: "rotate", page, degrees }`, `{ type: "delete_pages"/"extract_pages"/"reorder_pages", pages }`,
  `{ type: "split", at }`.
- Таблицы/табличные данные: PDF читается по координатам (таблицы и колонки
  сохраняются), XLSX/ODS/CSV/RTF тоже поддерживаются через doc_read/search.
- Текст внутри абзаца PDF не переписывается: только наложение или перерисовка.

## Проверка результата

После записи всегда читай файл обратно: `doc_read` первых страниц и
`doc_outline`, чтобы убедиться, что структура не развалилась.

## Кириллица

Шрифты берутся из системы (DejaVu, Liberation, Segoe UI, Arial). Если в
результате `doc_create`/`doc_format` пришло «шрифт без Unicode» — предупреди,
что не-латиница может не отобразиться.
