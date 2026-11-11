import { createContext, type KeyboardEvent, type ReactNode, useContext, useState } from "react";
import type { EnvironmentId, ServerSettings } from "@t3tools/contracts";

import { isEditableFocused } from "../../lib/editableFocus";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import { toastManager } from "../ui/toast";

type Undo = () => Promise<boolean> | boolean;
type Entry = { undos: Undo[]; pending: number; order: number };

function createHistory() {
  const entries: Entry[] = [];
  let order = 0;
  let failureVersion = 0;
  let gesture: Entry | null = null;
  const restore = (entry: Entry) => {
    entries.push(entry);
    entries.sort((a, b) => a.order - b.order);
  };
  let queue = Promise.resolve();
  const enqueue = (work: () => Promise<void>, title: string) => {
    queue = queue.then(work).catch(() => {
      toastManager.add({ type: "error", title });
    });
  };
  return {
    settings: new Map<EnvironmentId, { observed: ServerSettings | null; saved: ServerSettings }>(),
    record(save: () => Promise<Undo | null>, onFailed?: () => void) {
      if (!gesture) {
        gesture = { undos: [], pending: 0, order: order++ };
        entries.push(gesture);
        if (entries.length > 100) entries.shift();
        // Several saves from one gesture (such as restoring defaults) undo together.
        queueMicrotask(() => {
          gesture = null;
        });
      }
      const entry = gesture;
      entry.pending += 1;
      enqueue(async () => {
        try {
          const undo = await save();
          if (undo) entry.undos.push(undo);
        } catch (error) {
          onFailed?.();
          throw error;
        } finally {
          entry.pending -= 1;
          if (entry.pending === 0 && entry.undos.length === 0) {
            const index = entries.indexOf(entry);
            if (index !== -1) entries.splice(index, 1);
          }
        }
      }, "Setting not saved");
    },
    undo() {
      const entry = entries.pop();
      if (!entry) return false;
      const version = failureVersion;
      enqueue(async () => {
        if (version !== failureVersion) {
          restore(entry);
          return;
        }
        let restored = false;
        try {
          while (entry.undos.length > 0) {
            if (!(await entry.undos.at(-1)!())) return;
            entry.undos.pop();
          }
          restored = true;
        } finally {
          if (!restored) {
            failureVersion += 1;
            restore(entry);
          }
        }
      }, "Could not undo setting change");
      return true;
    },
  };
}

const SettingsUndoContext = createContext<ReturnType<typeof createHistory> | null>(null);

export function useSettingsUndo() {
  return useContext(SettingsUndoContext);
}

export function SettingsUndoProvider({ children }: { children: ReactNode }) {
  const [current] = useState(createHistory);
  const onKeyDown = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      event.key.toLowerCase() !== "z" ||
      !(isMacPlatform(navigator.platform)
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey) ||
      event.shiftKey ||
      event.altKey ||
      isEditableFocused(event.target) ||
      (event.target instanceof Element &&
        event.target
          .closest('[role="dialog"], [role="alertdialog"]')
          ?.hasAttribute("data-app-modal") !== true)
    )
      return;
    if (!event.repeat && !current.undo()) return;
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <SettingsUndoContext value={current}>
      <div className="contents" onKeyDown={onKeyDown}>
        {children}
      </div>
    </SettingsUndoContext>
  );
}
