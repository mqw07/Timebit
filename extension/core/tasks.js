export function applyTaskCommand(state, command, now) {
  const tasks = state.tasks ?? [];
  const revision = state.tasksRevision ?? 0;
  const save = (next) => ({ state: { ...state, tasks: next, tasksRevision: revision + 1 } });
  const text = typeof command.text === "string" ? command.text.trim() : "";

  switch (command.type) {
    case "tasks.add":
      if (!text) return { state, error: "Enter a task." };
      return save([...tasks, {
        id: crypto.randomUUID(), text, completed: false, createdAt: now, updatedAt: now,
      }]);
    case "tasks.clearCompleted":
    case "tasks.clearAll": {
      if (command.expectedTasksRevision !== revision) {
        return { state, error: "The task list changed. Review it and try again." };
      }
      const next = command.type === "tasks.clearAll" ? [] : tasks.filter((task) => !task.completed);
      return next.length === tasks.length ? { state } : save(next);
    }
    case "tasks.edit":
    case "tasks.setCompleted":
    case "tasks.delete": {
      const task = tasks.find(({ id }) => id === command.id);
      if (!task) return { state, error: "This task was deleted." };
      if (command.type === "tasks.delete") return save(tasks.filter(({ id }) => id !== task.id));

      let changes;
      if (command.type === "tasks.edit") {
        if (!text) return { state, error: "Enter a task." };
        if (task.text === text) return { state };
        if (task.text !== command.previousText) {
          return { state, error: "This task was edited in another view. Reopen it to see the latest text." };
        }
        changes = { text };
      } else {
        if (typeof command.completed !== "boolean") return { state, error: "Choose a valid task status." };
        if (task.completed === command.completed) return { state };
        changes = { completed: command.completed };
      }
      return save(tasks.map((item) => item === task ? { ...task, ...changes, updatedAt: now } : item));
    }
    default:
      return { state, error: "Unknown Timebit command." };
  }
}
