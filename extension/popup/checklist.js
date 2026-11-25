export function createChecklists(send) {
  const template = document.getElementById("checklist-template");
  const rowTemplate = document.getElementById("task-row-template");
  const editDialog = document.getElementById("edit-task");
  const editForm = editDialog.querySelector("form");
  const editInput = editForm.elements.namedItem("text");
  const editMessage = editDialog.querySelector(".message");
  const clearDialog = document.getElementById("clear-tasks");
  const clearCompleted = document.getElementById("clear-completed");
  const clearAll = document.getElementById("clear-all");

  let tasks = new Map();
  let revision;
  let editing;
  let clearRevision;

  const checklists = [...document.querySelectorAll("[data-checklist]")].map((container) => {
    container.append(template.content.cloneNode(true));
    const form = container.querySelector("form");
    const input = form.elements.namedItem("text");
    const list = container.querySelector("ul");

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = input.value;
      if (await send({ type: "tasks.add", text }) && input.value === text) input.value = "";
    });

    list.addEventListener("change", async (event) => {
      const checkbox = event.target;
      const task = tasks.get(checkbox.closest("li").dataset.taskId);
      const saved = await send({ type: "tasks.setCompleted", id: task.id, completed: checkbox.checked });
      if (!saved) checkbox.checked = tasks.get(task.id)?.completed ?? task.completed;
    });

    list.addEventListener("click", (event) => {
      const button = event.target.closest("[data-task-action]");
      if (!button) return;
      const task = tasks.get(button.closest("li").dataset.taskId);
      if (button.dataset.taskAction === "delete") {
        send({ type: "tasks.delete", id: task.id });
        return;
      }
      editing = task;
      editInput.value = task.text;
      editMessage.textContent = "";
      editDialog.showModal();
      editInput.select();
    });

    return { input, list, rows: new Map() };
  });

  editForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const { id, text: previousText } = editing;
    const saved = await send({ type: "tasks.edit", id, previousText, text: editInput.value }, editMessage);
    if (saved && editing.id === id) editDialog.close();
  });
  clearCompleted?.addEventListener("click", () => {
    send({ type: "tasks.clearCompleted", expectedTasksRevision: revision });
  });
  clearAll?.addEventListener("click", () => {
    clearRevision = revision;
    clearDialog.showModal();
  });
  clearDialog?.querySelector("form").addEventListener("submit", (event) => {
    event.preventDefault();
    clearDialog.close();
    send({ type: "tasks.clearAll", expectedTasksRevision: clearRevision });
  });
  for (const button of document.querySelectorAll("[data-close-dialog]")) {
    button.addEventListener("click", () => button.closest("dialog").close());
  }

  return (nextTasks, nextRevision) => {
    if (revision === nextRevision) return;
    revision = nextRevision;
    tasks = new Map(nextTasks.map((task) => [task.id, task]));
    if (clearCompleted) clearCompleted.disabled = !nextTasks.some((task) => task.completed);
    if (clearAll) clearAll.disabled = !nextTasks.length;

    for (const { input, list, rows } of checklists) {
      for (const [id, row] of rows) {
        if (tasks.has(id)) continue;
        if (row.contains(document.activeElement)) {
          const next = nextTasks.find((task) => rows.has(task.id));
          (rows.get(next?.id)?.querySelector("input") ?? input).focus();
        }
        row.remove();
        rows.delete(id);
      }

      for (const task of nextTasks) {
        let row = rows.get(task.id);
        if (!row) {
          row = rowTemplate.content.firstElementChild.cloneNode(true);
          row.dataset.taskId = task.id;
          list.append(row);
          rows.set(task.id, row);
        }
        row.querySelector("span").textContent = task.text;
        row.querySelector("input").checked = task.completed;
        for (const button of row.querySelectorAll("button")) {
          button.setAttribute("aria-label", `${button.textContent} ${task.text}`);
        }
      }
      list.hidden = !nextTasks.length;
    }
  };
}
