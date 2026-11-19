// Dropdown in granka's own visual language: a bordered button plus a floating
// list. Used instead of native <select> so theming and keyboard behaviour match
// the rest of the app.
(function () {
  let panel = null;
  let anchor = null;

  function close() {
    const hadFocus = panel && (panel.contains(document.activeElement) || anchor === document.activeElement);
    panel?.remove();
    panel = null;
    if (anchor) {
      anchor.setAttribute("aria-expanded", "false");
      if (hadFocus) anchor.focus();
    }
    anchor = null;
  }

  document.addEventListener("mousedown", (event) => {
    if (!panel) return;
    if (event.target.closest(".selectPanel") || event.target.closest(".selectBtn")) return;
    close();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panel) close();
  });

  // Full keyboard navigation inside an open panel: arrows move between
  // options, Home/End jump to the ends (buttons are natively focusable).
  document.addEventListener("keydown", (event) => {
    if (!panel) return;
    const item = event.target.closest?.(".selectItem");
    if (!item) return;
    const items = [...panel.querySelectorAll(".selectItem")];
    const index = items.indexOf(item);
    if (index < 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      (items[index + 1] ?? items[0]).focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      (items[index - 1] ?? items[items.length - 1]).focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0].focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1].focus();
    }
  });

  function create({ options = [], groups = [], value, onChange, ariaLabel, width }) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "selectBtn";
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");
    if (ariaLabel) button.setAttribute("aria-label", ariaLabel);
    if (width) button.style.width = width;

    const label = document.createElement("span");
    label.className = "selectLabel";
    button.append(label, chevron());

    const lookup = () => {
      const all = [...(groups.flatMap((group) => group.options) ?? []), ...options];
      return all;
    };

    const sync = () => {
      const current = lookup().find((option) => option.value === value);
      label.textContent = current?.label ?? "—";
      button.title = current?.label ?? "";
    };

    const open = () => {
      if (panel && anchor === button) return close();
      close();
      anchor = button;
      button.setAttribute("aria-expanded", "true");

      panel = document.createElement("div");
      panel.className = "selectPanel";
      panel.setAttribute("role", "listbox");
      panel.setAttribute("aria-label", ariaLabel ?? "Выбор");

      const addItem = (option) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = `selectItem${option.value === value ? " isCurrent" : ""}`;
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(option.value === value));
        const text = document.createElement("span");
        text.textContent = option.label;
        item.append(text);
        if (option.value === value) item.append(check());
        item.addEventListener("click", () => {
          value = option.value;
          sync();
          close();
          onChange?.(option.value);
          button.focus();
        });
        panel.append(item);
        return item;
      };

      for (const group of groups) {
        const heading = document.createElement("div");
        heading.className = "selectGroup";
        heading.textContent = group.label;
        panel.append(heading);
        for (const option of group.options) addItem(option);
      }
      for (const option of options) addItem(option);

      document.body.append(panel);
      const rect = button.getBoundingClientRect();
      const width = Math.max(panel.offsetWidth, rect.width);
      panel.style.width = `${width}px`;
      panel.style.left = `${Math.min(rect.left, window.innerWidth - width - 8)}px`;
      const below = rect.bottom + 4;
      const fitsBelow = below + panel.offsetHeight < window.innerHeight - 8;
      panel.style.top = `${fitsBelow ? below : Math.max(8, rect.top - panel.offsetHeight - 4)}px`;
      panel.querySelector(".selectItem.isCurrent")?.focus();
    };

    button.addEventListener("click", open);
    button.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });

    sync();
    return { element: button, setValue: (next) => { value = next; sync(); } };
  }

  function chevron() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon chevron");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#i-chevron-down");
    svg.append(use);
    return svg;
  }

  function check() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#i-check");
    svg.append(use);
    return svg;
  }

  // --- model rows: name only, price on the right, grouped by cost ---------

  function modelName(id) {
    const slash = String(id).lastIndexOf("/");
    return slash >= 0 ? String(id).slice(slash + 1) : String(id);
  }

  function modelCompany(id) {
    const slash = String(id).lastIndexOf("/");
    return slash >= 0 ? String(id).slice(0, slash) : "";
  }

  function modelPrice(model) {
    const input = model?.cost?.input ?? 0;
    const output = model?.cost?.output ?? 0;
    if (input === 0 && output === 0) return "free";
    return `${input}$/${output}$ за 1M`;
  }

  function isFree(model) {
    return (model?.cost?.input ?? 0) === 0 && (model?.cost?.output ?? 0) === 0;
  }

  function modelRow(model, { current, favorite, onSelect, onToggleFavorite }) {
    const row = document.createElement("div");
    row.className = `modelRow${current ? " isCurrent" : ""}`;

    const pick = document.createElement("button");
    pick.className = "modelPick";
    pick.setAttribute("role", "option");
    pick.setAttribute("aria-selected", String(Boolean(current)));
    const name = document.createElement("span");
    name.className = "modelName";
    name.textContent = modelName(model.id);
    const company = document.createElement("span");
    company.className = "modelCompany";
    company.textContent = modelCompany(model.id);
    pick.append(name, company);
    if (current) pick.append(check());
    pick.addEventListener("click", () => onSelect(model.id));
    row.append(pick);

    if (onToggleFavorite) {
      const star = document.createElement("button");
      star.className = `modelFav${favorite ? " isFav" : ""}`;
      star.title = favorite ? "Убрать из избранного" : "В избранное";
      star.setAttribute("aria-label", star.title);
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "icon");
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
      use.setAttribute("href", "#i-star");
      svg.append(use);
      star.append(svg);
      star.addEventListener("click", (event) => {
        event.stopPropagation();
        onToggleFavorite(model.id);
      });
      row.append(star);
    }

    const price = document.createElement("span");
    price.className = `modelPrice${isFree(model) ? " isFree" : ""}`;
    price.textContent = modelPrice(model);
    row.append(price);
    return row;
  }

  function renderModelRows(container, { models, favorites = [], current, query = "", onSelect, onToggleFavorite, limit = 80 }) {
    const needle = String(query ?? "").trim().toLowerCase();
    const matches = models.filter(
      (model) => !needle || model.id.toLowerCase().includes(needle) || modelName(model.id).toLowerCase().includes(needle) || modelCompany(model.id).toLowerCase().includes(needle),
    );
    const favoriteSet = new Set(favorites);
    const favoritesList = matches.filter((model) => favoriteSet.has(model.id));
    const free = matches.filter((model) => !favoriteSet.has(model.id) && isFree(model));
    const paid = matches.filter((model) => !favoriteSet.has(model.id) && !isFree(model));

    container.replaceChildren();
    const section = (label, items) => {
      if (!items.length) return;
      const heading = document.createElement("div");
      heading.className = "modelGroup";
      heading.textContent = `${label} · ${items.length}`;
      container.append(heading);
      for (const model of items.slice(0, limit)) {
        container.append(
          modelRow(model, {
            current: model.id === current,
            favorite: favoriteSet.has(model.id),
            onSelect,
            onToggleFavorite,
          }),
        );
      }
    };

    section("★ Избранные", favoritesList);
    section("Бесплатные", free);
    section("Платные", paid);
    if (container.querySelectorAll(".modelRow").length >= limit) {
      const more = document.createElement("div");
      more.className = "modelEmpty";
      more.textContent = "Показаны первые модели — уточните поиск";
      container.append(more);
    }

    if (!container.childElementCount) {
      const empty = document.createElement("div");
      empty.className = "modelEmpty";
      empty.textContent = "Ничего не найдено";
      container.append(empty);
    }
  }

  // DESIGN.md segmented control for 2-4 mutually exclusive options.
  function createSegment({ options = [], value, onChange, ariaLabel }) {
    const wrap = document.createElement("div");
    wrap.className = "segmented";
    wrap.setAttribute("role", "radiogroup");
    if (ariaLabel) wrap.setAttribute("aria-label", ariaLabel);
    for (const option of options) {
      const button = document.createElement("button");
      button.className = `segment${option.value === value ? " isActive" : ""}`;
      button.type = "button";
      button.textContent = option.label;
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(option.value === value));
      button.addEventListener("click", async () => {
        if (button.classList.contains("isActive")) return;
        for (const sibling of wrap.querySelectorAll(".segment")) {
          sibling.classList.toggle("isActive", sibling === button);
          sibling.setAttribute("aria-checked", String(sibling === button));
        }
        await onChange?.(option.value);
      });
      wrap.append(button);
    }
    return { element: wrap };
  }

  globalThis.grankaSelect = { create, close, createSegment };
  globalThis.grankaModels = { modelName, modelCompany, modelPrice, isFree, renderModelRows };
})();
