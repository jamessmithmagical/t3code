import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { useEnvironmentsWithScope } from "../../state/session";
import {
  requiredScopesForServerSettingsPatch,
  EnvironmentAuthorizationError,
} from "@t3tools/contracts";
import { readEnvironmentScope } from "../../state/session";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import {
  DEFAULT_SERVER_SETTINGS,
  type ProjectScopedServerSettingKey,
  type ServerSettings,
  type UnifiedSettings,
} from "@t3tools/contracts";

import {
  ensureClientSettingsHydrated,
  getClientSettings,
  persistClientSettingsPatch,
  persistClientSettingsUpdate,
  useMergedSettings,
} from "../../hooks/useSettings";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useSettingsUndo } from "./SettingsUndo";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import {
  persistScopedSettingsPatch,
  planProjectOverridesClear,
  planScopedSettingsClear,
  planScopedSettingsPatch,
  scopedSettingsAreMixed,
  scopedSettingsSource,
  reverseScopedSettingsPlan,
  scopedSettingsUndoIsCurrent,
  type ProjectOverrideEntry,
  type ScopedSettingsPatch,
} from "./scopedSettings";

export function useScopedSettings<T = UnifiedSettings>(
  selector?: (settings: UnifiedSettings) => T,
): T {
  const { target } = useSettingsScope();
  return useMergedSettings(target?.settings ?? DEFAULT_SERVER_SETTINGS, selector);
}

export function useScopedSettingsMixed(keys: readonly (keyof ServerSettings)[]): boolean {
  const { targets } = useSettingsScope();
  return scopedSettingsAreMixed(targets, keys);
}

export function useScopedSettingSource(keys: readonly (keyof ServerSettings)[]) {
  const { targets } = useSettingsScope();
  return scopedSettingsSource(targets, keys);
}

function useRunScopedPlan() {
  const persistServer = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const history = useSettingsUndo();
  const save = async (plan: ReturnType<typeof planScopedSettingsPatch>, onFailed?: () => void) => {
    if (plan.unavailableReason) {
      toastManager.add({
        type: "warning",
        title: "Setting not saved",
        description: plan.unavailableReason,
      });
      onFailed?.();
      return null;
    }
    const result = await persistScopedSettingsPatch(
      plan,
      async (request) => {
        const missing = requiredScopesForServerSettingsPatch(request.input.patch).find(
          (scope) => !readEnvironmentScope(request.environmentId, scope),
        );
        if (missing)
          return AsyncResult.failure(
            Cause.fail(
              new EnvironmentAuthorizationError({
                requiredScope: missing,
                message: "This connection lacks permission to change these settings.",
              }),
            ),
          );
        const result = await persistServer(request);
        if (result._tag === "Success" && history) {
          history.settings.set(request.environmentId, {
            observed: appAtomRegistry.get(
              serverEnvironment.settingsValueAtom(request.environmentId),
            ),
            saved: result.value,
          });
        }
        return result;
      },
      history
        ? (patch) => persistClientSettingsUpdate((current) => ({ ...current, ...patch }))
        : persistClientSettingsPatch,
    );
    const { failedEnvironments, savedEnvironments, savedEnvironmentCount } = result;
    if (failedEnvironments.length > 0) {
      onFailed?.();
      toastManager.add({
        type: "error",
        title:
          savedEnvironmentCount > 0 ? "Setting saved on some environments" : "Setting not saved",
        description: [
          ...failedEnvironments.map(
            ({ label, message }) => `Could not save on ${label}: ${message}`,
          ),
          ...(savedEnvironmentCount > 0
            ? [`Saved on ${savedEnvironments.map(({ label }) => label).join(", ")}.`]
            : []),
        ].join("\n"),
      });
    }
    return result;
  };
  return (makePlan: () => ReturnType<typeof planScopedSettingsPatch>, onFailed?: () => void) => {
    if (!history) {
      void save(makePlan(), onFailed);
      return;
    }
    history.record(async () => {
      await ensureClientSettingsHydrated();
      const plan = makePlan();
      const reverse = reverseScopedSettingsPlan(plan, getClientSettings());
      const result = await save(plan, onFailed);
      if (!result) return null;
      // Secret values in streamed settings are redacted and cannot be restored.
      if (
        plan.serverWrites.some(
          ({ patch }) =>
            patch.secretProviders || patch.cloudSpeechCredentials || patch.sourceControlHosts,
        )
      )
        return null;
      const saved = new Set(result.savedEnvironments.map((write) => write.environmentId));
      const undoPlan = {
        ...reverse,
        serverWrites: reverse.serverWrites
          .filter((write) => saved.has(write.environmentId))
          .map((write) => ({
            ...write,
            previous: history.settings.get(write.environmentId)?.saved ?? write.previous,
          })),
      };
      if (!undoPlan.hasClientWrite && undoPlan.serverWrites.length === 0) return null;
      return async () => {
        if (
          undoPlan.serverWrites.some((write) => {
            const observed = appAtomRegistry.get(
              serverEnvironment.settingsValueAtom(write.environmentId),
            );
            const cached = history.settings.get(write.environmentId);
            const current = cached?.observed === observed ? cached.saved : observed;
            return current !== null && !scopedSettingsUndoIsCurrent(write, current);
          })
        ) {
          toastManager.add({
            type: "warning",
            title: "Setting changed elsewhere",
            description: "Undo skipped to keep the newer change.",
          });
          return true;
        }
        const undone = await save(undoPlan);
        if (!undone) return false;
        const failed = new Set(undone.failedEnvironments.map((write) => write.environmentId));
        undoPlan.serverWrites = undoPlan.serverWrites.filter((write) =>
          failed.has(write.environmentId),
        );
        undoPlan.hasClientWrite = false;
        return failed.size === 0;
      };
    }, onFailed);
  };
}

function useSettingsWriteEnvironments() {
  const context = useOptionalSettingsScope();
  const history = useSettingsUndo();
  return () =>
    (context?.environments ?? []).map((environment) => {
      const observed = appAtomRegistry.get(
        serverEnvironment.settingsValueAtom(environment.environmentId),
      );
      const cached = history?.settings.get(environment.environmentId);
      const settings = cached?.observed === observed ? cached.saved : observed;
      return settings && environment.serverConfig
        ? { ...environment, serverConfig: { ...environment.serverConfig, settings } }
        : environment;
    });
}

export function useUpdateScopedSettings() {
  const { scope } = useSettingsScope();
  const environments = useSettingsWriteEnvironments();
  const run = useRunScopedPlan();
  /** `onFailed` runs when any target rejects or drops the patch, so a draft can fall back. */
  return (patch: ScopedSettingsPatch, options?: { readonly onFailed?: () => void }) =>
    run(() => planScopedSettingsPatch(scope, environments(), patch), options?.onFailed);
}

export function useClearScopedSettings() {
  const context = useOptionalSettingsScope();
  const environments = useSettingsWriteEnvironments();
  const run = useRunScopedPlan();
  return (keys: readonly ProjectScopedServerSettingKey[]) => {
    if (context === null) return;
    run(() => planScopedSettingsClear(context.scope, environments(), keys));
  };
}

export function useClearProjectOverrides() {
  const context = useOptionalSettingsScope();
  const environments = useSettingsWriteEnvironments();
  const run = useRunScopedPlan();
  return (
    entries: readonly ProjectOverrideEntry[],
    keys: readonly ProjectScopedServerSettingKey[],
  ) => {
    if (context === null) return;
    run(() => planProjectOverridesClear(environments(), entries, keys));
  };
}

export function useScopedSettingsWriteAllowed() {
  const { connectedEnvironments } = useSettingsScope();
  const writable = useEnvironmentsWithScope(connectedEnvironments, AuthSettingsWriteScope);
  return (
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every((target) => writable.has(target.environmentId))
  );
}
