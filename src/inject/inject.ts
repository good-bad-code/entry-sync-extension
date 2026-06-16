const PREFIX = '?!';

function extractProjectId(url: string): string | null {
  try {
    const u = new URL(url);
    const match = u.pathname.match(/^\/(project|ws|iframe)\/([^\/?#]+)/);
    return match ? match[2] : null;
  } catch { return null; }
}

function log(...args: unknown[]) {
  console.log('[EntrySync]', ...args);
}

function logVarChange(action: string, name: string, value: unknown) {
  console.log(`[EntrySync:VAR] ${action} | name="${name}" | value="${value}" | ts=${Date.now()}`);
}

function logListChange(action: string, name: string, op: string, args: unknown[]) {
  console.log(`[EntrySync:LIST] ${action} | name="${name}" | op="${op}" | args=${JSON.stringify(args)} | ts=${Date.now()}`);
}

function isGlobalVariable(v: any): boolean {
  return v && !v.object_;
}

function isSyncVariable(v: any): boolean {
  // "?!" (bare prefix) is the health-check variable — NOT synced
  // "?!name" variables/lists ARE synced
  return v && typeof v.name_ === 'string' && v.name_.startsWith(PREFIX) && v.name_ !== PREFIX;
}

function getVarName(v: any): string {
  return v ? v.getName() : '(unknown)';
}

function extractArray(listInstance: any): unknown[] {
  const raw = listInstance.getArray?.() ?? listInstance.array_ ?? [];
  if (Array.isArray(raw)) {
    if (raw.length > 0 && typeof raw[0] === 'object' && raw[0] !== null && 'data' in raw[0])
      return raw.map((item: any) => item.data);
    if (raw.length > 0 && typeof raw[0] === 'object' && raw[0] !== null && 'value' in raw[0])
      return raw.map((item: any) => item.value);
    return raw;
  }
  return [];
}

let applyingRemoteVar = false;
let applyingRemoteList = false;
let syncBlockCount = 0;
const pendingUpdates: Array<any> = [];
let initialized = false; // INIT_SYNC_RESULT 수신 전 setValue 메시지 차단
let dbSnapshot: Map<string, any> | null = null;
let stabilizing = false;

function hookEntryEvents(Entry: any) {
  Entry.addEventListener('blockExecute', (blockView: any) => {
    if (!blockView) return;
    const block = blockView.block;
    if (!block || !block.type) return;
    const type = block.type;
    const params = block.params || [];

    const isVarBlock =
      type === 'entry_set_variable' || type === 'entry_change_variable';
    const isListBlock =
      type === 'entry_list_add' ||
      type === 'entry_list_remove' ||
      type === 'entry_list_insert' ||
      type === 'entry_list_change' ||
      type === 'entry_list_delete' ||
      type === 'list_remove_all_items';

    if (isVarBlock || isListBlock) {
      syncBlockCount++;
      log(`blockExecute: ${type} | params=${JSON.stringify(params)} | syncBlockCount now ${syncBlockCount}`);
      // Release the lock after block execution completes
      // Entry blocks typically finish within <100ms
      setTimeout(() => {
        syncBlockCount--;
        if (syncBlockCount < 0) syncBlockCount = 0;
        if (syncBlockCount === 0) {
          processPendingUpdates(Entry);
        }
      }, 500);
    }
  });
}

function notifyParent(kind: 'var' | 'list', name: string, value: unknown) {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'ENTRY_SYNC_UPDATE', kind, name, value, timestamp: Date.now() }, '*');
    }
  } catch { /* cross-origin silently ignore */ }
}

function handleSyncUpdate(Entry: any, msg: any) {
  if (msg.kind === 'var') {
    applyingRemoteVar = true;
    try {
      const v = (Entry.variableContainer.variables_ || []).find((x: any) => x.name_ === msg.name);
      if (v) { v.value_ = msg.value; if (v.view_?.updateView) v.view_.updateView(); }
    } finally { applyingRemoteVar = false; }
  } else if (msg.kind === 'list') {
    applyingRemoteList = true;
    try {
      const l = (Entry.variableContainer.lists_ || []).find((x: any) => x.name_ === msg.name);
      if (l) {
        const wrapped = ((msg.value || []) as unknown[]).map((v: unknown) => ({ data: v }));
        l.array_ = wrapped;
        if (l.view_) {
          if (typeof l.view_.updateView === 'function') l.view_.updateView();
          if (typeof l.view_.setList === 'function') l.view_.setList(wrapped);
        }
        (Entry as any).requestUpdate = true;
        if (Entry.stage && typeof Entry.stage.update === 'function') Entry.stage.update();
      }
    } finally { applyingRemoteList = false; }
  }
}

function hookVariableSetValue(Entry: any) {
  const orig = Entry.Variable?.prototype?.setValue;
  if (!orig) {
    log('WARN: Variable.prototype.setValue not found');
    return;
  }

  Entry.Variable.prototype.setValue = function (this: any, value: unknown) {
    // Skip list-type variables (list has its own hooks)
    if (this.type === 'list') {
      return orig.call(this, value);
    }

    // ?! health check: silently convert 0 to random to keep Entry alive
    if (this.name_ === PREFIX && value === 0) {
      value = 1;
      log(`?! health check: converting 0 to ${value}`);
    }

    logVarChange('HOOK:setValue called', this.name_, value);

    // ALLOW+SEND: call orig first, then notify
    const result = orig.call(this, value);

    // Send operation (only if sync variable and not applying remote)
    if (isSyncVariable(this) && isGlobalVariable(this)) {
      if (!initialized) {
        logVarChange('SKIP:!initialized', this.name_, value);
      } else if (stabilizing) {
        logVarChange('SKIP:stabilizing', this.name_, value);
      } else if (applyingRemoteVar) {
        logVarChange('SKIP:applyingRemoteVar', this.name_, value);
      } else {
        logVarChange('SEND:postMessage', this.name_, this.value_);
        window.postMessage(
          {
            type: 'ENTRY_VAR_CHANGE',
            name: this.name_,
            value: this.value_,
            projectId: extractProjectId(window.location.href),
            timestamp: Date.now(),
          },
          '*'
        );
        notifyParent('var', this.name_, this.value_);
      }
    }

    return result;
  };

  log('Hooked: Variable.prototype.setValue (ALLOW+SEND)');
}

function hookListMethods(Entry: any) {
  const lists = Entry.variableContainer?.lists_;
  if (!lists || lists.length === 0) {
    setTimeout(() => hookListMethods(Entry), 1000);
    return;
  }

  const listProto = Object.getPrototypeOf(lists[0]);
  if (!listProto) return;
  if (listProto.__entrySyncListHooked) return;

  const methodsToHook = ['appendValue', 'deleteValue', 'insertValue', 'replaceValue', 'setArray'];
  const origMethods: Record<string, Function> = {};
  for (const name of methodsToHook) {
    const orig = listProto[name];
    if (orig && !orig.__entrySyncHooked) origMethods[name] = orig;
  }

  for (const [name, orig] of Object.entries(origMethods)) {
    listProto[name] = function (this: any, ...args: unknown[]) {
      logListChange('HOOK:method called', this.name_, name, args);

      // ALLOW+SEND: call orig first, then notify
      const result = orig.apply(this, args);

      // ?! list health check: auto-reset 0 to random
      if (this.name_ === PREFIX) {
        const arr = extractArray(this);
        if (arr.length === 1 && arr[0] === 0) {
          const newValue = 1;
          log(`?! list health check: converting 0 to ${newValue}`);
          this.array_ = [{ data: newValue }];
          if (this.view_) {
            if (typeof this.view_.updateView === 'function') this.view_.updateView();
            if (typeof this.view_.setList === 'function') this.view_.setList(this.array_);
          }
          (Entry as any).requestUpdate = true;
          if (Entry.stage?.update) Entry.stage.update();
        }
      }

      if (isSyncVariable(this) && isGlobalVariable(this)) {
        if (applyingRemoteList) {
          logListChange('SKIP:applyingRemoteList', this.name_, name, args);
        } else {
          logListChange('SEND:postMessage', this.name_, name, args);
          window.postMessage(
            {
              type: 'ENTRY_LIST_CHANGE',
              name: this.name_,
              operation: name,
              args: args,
              projectId: extractProjectId(window.location.href),
              timestamp: Date.now(),
            },
            '*'
          );
          notifyParent('list', this.name_, extractArray(this));
        }
      }

      return result;
    };
    listProto[name].__entrySyncHooked = true;
  }

  listProto.__entrySyncListHooked = true;
  patchExistingInstances(lists, listProto);

  // Lists array push hook (keep for new instances)
  const listsArr = Entry.variableContainer.lists_;
  const origPush = listsArr.__proto__.push;
  listsArr.__proto__.push = function (this: any[], ...items: any[]) {
    const result = origPush.apply(this, items);
    const proto = (items.length > 0 && items[0] != null) ? Object.getPrototypeOf(items[0]) : listProto;
    patchExistingInstances(this, proto);
    return result;
  };

  log(`Hooked: ListVariable.prototype methods (ALLOW+SEND pattern, ${methodsToHook.join(', ')})`);
}

function patchExistingInstances(lists: any[], proto: any) {
  if (!lists || !proto) return;
  for (let i = 0; i < lists.length; i++) {
    const inst = lists[i];
    if (!inst || !inst.hasOwnProperty) continue;
    for (const name of [
      'appendValue',
      'deleteValue',
      'insertValue',
      'replaceValue',
      'setArray',
    ]) {
      if (inst.hasOwnProperty(name)) {
        inst[name] = proto[name];
      }
    }
  }
}

/**
 * Some Entry Variable instances have setValue as an own property (copied
 * from prototype during construction). Our prototype-level hook won't
 * affect those instances unless we patch them explicitly.
 * This mirrors patchExistingInstances() for list prototypes.
 */
function patchExistingVariables(Entry: any) {
  const variables = Entry.variableContainer?.variables_;
  const proto = Entry.Variable?.prototype;
  if (!proto || !variables || !variables.length) return;
  for (const v of variables) {
    if (v && typeof v.hasOwnProperty === 'function' && v.hasOwnProperty('setValue') && v.setValue !== proto.setValue) {
      v.setValue = proto.setValue;
      log(`Patched instance-owned setValue for variable: ${v.name_}`);
    }
  }
}

function startStabilization(Entry: any, durationMs: number) {
  if (stabilizing) return;
  stabilizing = true;
  const startTime = Date.now();
  log(`Stabilization started for ${durationMs}ms with ${dbSnapshot?.size || 0} tracked entries`);

  const timer = setInterval(() => {
    if (Date.now() - startTime > durationMs) {
      clearInterval(timer);
      stabilizing = false;
      dbSnapshot = null;
      initialized = true;  // NOW it's safe to send to DB
      log('Stabilization complete — DB values locked in, initialized=true');
      return;
    }

    // Check all sync variables
    for (const v of (Entry.variableContainer?.variables_ || [])) {
      if (!isSyncVariable(v) || !isGlobalVariable(v)) continue;
      if (v.name_ === PREFIX) continue;
      const snapshotVal = dbSnapshot?.get(v.name_);
      if (snapshotVal !== undefined && v.value_ !== snapshotVal) {
        // Entry overwrote our DB value — re-apply
        logVarChange('STABILIZE:re-apply', v.name_, snapshotVal);
        v.value_ = snapshotVal;
        if (v.view_?.updateView) v.view_.updateView();
      }
    }

    // Check all sync lists
    for (const l of (Entry.variableContainer?.lists_ || [])) {
      if (!isSyncVariable(l) || !isGlobalVariable(l)) continue;
      if (l.name_ === PREFIX) continue;
      const snapshotVal = dbSnapshot?.get(l.name_);
      if (snapshotVal !== undefined) {
        const currentArr = extractArray(l);
        if (JSON.stringify(currentArr) !== JSON.stringify(snapshotVal)) {
          logListChange('STABILIZE:re-apply', l.name_, 'setArray', [snapshotVal]);
          const wrapped = (snapshotVal as unknown[]).map((v: unknown) => ({ data: v }));
          l.array_ = wrapped;
          if (l.view_) {
            if (typeof l.view_.updateView === 'function') l.view_.updateView();
            if (typeof l.view_.setList === 'function') l.view_.setList(wrapped);
          }
        }
      }
    }

    (Entry as any).requestUpdate = true;
    if (Entry.stage?.update) Entry.stage.update();
  }, 50);
}

function processPendingUpdates(Entry: any) {
  if (pendingUpdates.length === 0) return;
  const updates = pendingUpdates.splice(0);
  log(`Processing ${updates.length} pending updates`);
  for (const update of updates) {
    if (update.type === 'APPLY_VAR_UPDATE') {
      if (update.name === PREFIX) continue;
      applyingRemoteVar = true;
      try {
        const v = (Entry.variableContainer.variables_ || []).find((x: any) => x.name_ === update.name);
        if (v) {
          log(`processPendingUpdates APPLY_VAR_UPDATE: ${update.name} = ${update.value}`);
          v.value_ = update.value;
          if (v.view_?.updateView) v.view_.updateView();
          notifyParent('var', update.name, update.value);
        }
      } finally { applyingRemoteVar = false; }
    } else if (update.type === 'APPLY_LIST_UPDATE') {
      applyingRemoteList = true;
      try {
        const l = (Entry.variableContainer.lists_ || []).find((x: any) => x.name_ === update.name);
        if (l) {
          log(`processPendingUpdates APPLY_LIST_UPDATE: ${update.name} = [${(update.args[0] as unknown[] || []).length} items]`);
          const fullArray = (update.args[0] as unknown[]) || [];
          const wrapped = fullArray.map((v: unknown) => ({ data: v }));
          l.array_ = wrapped;
          if (l.view_) {
            if (typeof l.view_.updateView === 'function') l.view_.updateView();
            if (typeof l.view_.setList === 'function') l.view_.setList(wrapped);
          }
          (Entry as any).requestUpdate = true;
          if (Entry.stage && typeof Entry.stage.update === 'function') Entry.stage.update();
          notifyParent('list', update.name, fullArray);
        }
      } finally { applyingRemoteList = false; }
    } else if (update.type === 'INIT_SYNC_RESULT') {
      log(`processPendingUpdates INIT_SYNC_RESULT: ${Object.keys(update.vars || {}).length} vars, ${(update.lists || []).length} lists`);
      applyingRemoteVar = true;
      applyingRemoteList = true;
      try {
        for (const [name, value] of Object.entries(update.vars || {})) {
          if (name === PREFIX) continue;
          const v = (Entry.variableContainer.variables_ || []).find((x: any) => x.name_ === name);
          if (v) { v.value_ = value; if (v.view_?.updateView) v.view_.updateView(); notifyParent('var', name, value); }
        }
        for (const list of update.lists || []) {
          if (list.name === PREFIX) continue;
          const l = (Entry.variableContainer.lists_ || []).find((x: any) => x.name_ === list.name);
          if (!l) continue;
          const wrapped = (list.array as unknown[] || []).map((v: unknown) => ({ data: v }));
          l.array_ = wrapped;
          if (l.view_) {
            if (typeof l.view_.updateView === 'function') l.view_.updateView();
            if (typeof l.view_.setList === 'function') l.view_.setList(wrapped);
          }
          (Entry as any).requestUpdate = true;
          if (Entry.stage?.update) Entry.stage.update();
          notifyParent('list', list.name, list.array);
        }
        // Save DB snapshot for stabilization
        dbSnapshot = new Map<string, any>();
        for (const [name, value] of Object.entries(update.vars || {})) {
          if (name !== PREFIX) dbSnapshot.set(name, value);
        }
        for (const list of update.lists || []) {
          if (list.name !== PREFIX) dbSnapshot.set(list.name, list.array);
        }
      } finally {
        applyingRemoteList = false;
        applyingRemoteVar = false;
        // initialized = true; — defer to stabilization
        startStabilization(Entry, 3000);
      }
    }
  }
}

function listenForRemoteUpdates(Entry: any) {
  window.addEventListener('message', (event) => {
    const msg = event.data;

    log(`listenForRemoteUpdates: received type="${msg.type}" source=${event.source === window ? 'self' : 'cross-frame'}`);

    // Cross-frame messages (from iframe to parent)
    if (event.source !== window) {
      if (msg.type === 'ENTRY_SYNC_UPDATE') { handleSyncUpdate(Entry, msg); }
      return;
    }

    // Self messages — queue if blocks are executing
    if (syncBlockCount > 0 &&
        (msg.type === 'APPLY_VAR_UPDATE' || msg.type === 'APPLY_LIST_UPDATE' || msg.type === 'INIT_SYNC_RESULT')) {
      log(`listenForRemoteUpdates: QUEUED pending update (syncBlockCount=${syncBlockCount})`);
      pendingUpdates.push(msg);
      return;
    }

    if (msg.type === 'APPLY_VAR_UPDATE') {
      logVarChange('PROCESS:APPLY_VAR_UPDATE', msg.name, msg.value);
      applyingRemoteVar = true;
      try {
        const v = (Entry.variableContainer.variables_ || []).find(
          (x: any) => x.name_ === msg.name
        );
        if (!v) { logVarChange('SKIP:variable not found', msg.name, msg.value); return; }
        // ?! is health check only — never overwrite from remote
        if (msg.name === PREFIX) return;
        log(`APPLY_VAR_UPDATE: ${msg.name} = ${msg.value}`);
        // Direct assignment — avoids setValue hook re-entry
        v.value_ = msg.value;
        if (v.view_?.updateView) v.view_.updateView();
        notifyParent('var', msg.name, msg.value);
      } finally {
        applyingRemoteVar = false;
      }
    } else if (msg.type === 'APPLY_LIST_UPDATE') {
      logListChange('PROCESS:APPLY_LIST_UPDATE', msg.name, msg.operation, msg.args || []);
      applyingRemoteList = true;
      try {
        const l = (Entry.variableContainer.lists_ || []).find(
          (x: any) => x.name_ === msg.name
        );
        if (!l) { logListChange('SKIP:list not found', msg.name, msg.operation, msg.args || []); return; }
        log(`APPLY_LIST_UPDATE: ${msg.name} = [${(msg.args[0] as unknown[] || []).length} items]`);

        // DB value is the full array — wrap it
        const fullArray = (msg.args[0] as unknown[]) || [];
        const wrapped = fullArray.map((v: unknown) => ({ data: v }));
        l.array_ = wrapped;

        // Update view
        if (l.view_) {
          if (typeof l.view_.updateView === 'function') l.view_.updateView();
          if (typeof l.view_.setList === 'function') l.view_.setList(wrapped);
        }
        (Entry as any).requestUpdate = true;
        if (Entry.stage && typeof Entry.stage.update === 'function') {
          Entry.stage.update();
        }
        notifyParent('list', msg.name, fullArray);
      } finally {
        applyingRemoteList = false;
      }
    } else if (msg.type === 'INIT_SYNC_RESULT') {
      log(`listenForRemoteUpdates: PROCESS INIT_SYNC_RESULT — ${Object.keys(msg.vars || {}).length} vars, ${(msg.lists || []).length} lists`);
      // Apply DB values from INIT_SYNC_RESULT
      applyingRemoteVar = true;
      applyingRemoteList = true;
      try {
        for (const [name, value] of Object.entries(msg.vars || {})) {
          // ?! is health check only — never restore from DB
          if (name === PREFIX) continue;
          const v = (Entry.variableContainer.variables_ || []).find(
            (x: any) => x.name_ === name
          );
          if (v) {
            logVarChange('INIT_SYNC:apply', name, value);
            v.value_ = value;
            if (v.view_?.updateView) v.view_.updateView();
            notifyParent('var', name, value);
            (Entry as any).requestUpdate = true;
            if (Entry.stage?.update) Entry.stage.update();
          } else {
            logVarChange('INIT_SYNC:var not found', name, value);
          }
        }
        for (const list of msg.lists || []) {
          // ?! is health check only — never restore from DB
          if (list.name === PREFIX) continue;
          const l = (Entry.variableContainer.lists_ || []).find(
            (x: any) => x.name_ === list.name
          );
          if (!l) { logListChange('INIT_SYNC:list not found', list.name, 'setArray', []); continue; }
          logListChange('INIT_SYNC:apply', list.name, 'setArray', [list.array]);
          const wrapped = (list.array as unknown[] || []).map((v: unknown) => ({ data: v }));
          l.array_ = wrapped;
          if (l.view_) {
            if (typeof l.view_.updateView === 'function') l.view_.updateView();
            if (typeof l.view_.setList === 'function') l.view_.setList(wrapped);
          }
          (Entry as any).requestUpdate = true;
          if (Entry.stage?.update) Entry.stage.update();
          notifyParent('list', list.name, list.array);
        }
        // Save DB snapshot for stabilization
        dbSnapshot = new Map<string, any>();
        for (const [name, value] of Object.entries(msg.vars || {})) {
          if (name !== PREFIX) dbSnapshot.set(name, value);
        }
        for (const list of msg.lists || []) {
          if (list.name !== PREFIX) dbSnapshot.set(list.name, list.array);
        }
        // Final render trigger — ensures display updates even if no vars/lists were found
        (Entry as any).requestUpdate = true;
        if (Entry.stage?.update) Entry.stage.update();
      } finally {
        applyingRemoteList = false;
        applyingRemoteVar = false;
        // initialized = true; — defer to stabilization
        startStabilization(Entry, 3000);
      }
    }
  });
}

function startHealthCheckWatcher(Entry: any) {
  // 300ms interval — proven working pattern from entry_test/content.js
  setInterval(() => {
    if (!Entry || !Entry.variableContainer) return;

    // ?! variable health check — follows the exact same pattern as
    // entry_test/content.js which successfully keeps variables alive
    const healthVar = Entry.variableContainer.getVariableByName(PREFIX);
    if (healthVar) {
      const checkVal = String(healthVar.value_ || healthVar.getValue?.() || "").trim();

      if (checkVal === "0" || checkVal === "") {
        const newValue = 1;
        log(`?! health check: 0 detected, setting to ${newValue}`);

        if (typeof healthVar.setValue === 'function') {
          healthVar.setValue(newValue);
        } else {
          healthVar.value_ = newValue;
        }

        if (healthVar.view_ && typeof healthVar.view_.updateView === 'function') {
          healthVar.view_.updateView();
        }

        (Entry as any).requestUpdate = true;
        if (Entry.stage?.update) Entry.stage.update();
      }
    }

    const healthListArr = (Entry.variableContainer.lists_ || []).find(
      (l: any) => l.name_ === PREFIX
    );
    if (healthListArr) {
      const arr = extractArray(healthListArr);
      if (arr.length === 1 && arr[0] === 0) {
        const newValue = 1;
        log(`?! health check (list): 0 detected, resetting to ${newValue}`);
        healthListArr.array_ = [{ data: newValue }];
        if (healthListArr.view_) {
          if (typeof healthListArr.view_.updateView === 'function') healthListArr.view_.updateView();
          if (typeof healthListArr.view_.setList === 'function') healthListArr.view_.setList(healthListArr.array_);
        }
        (Entry as any).requestUpdate = true;
        if (Entry.stage?.update) Entry.stage.update();
      }
    }
  }, 50);
}

function init() {
  log('Looking for Entry...');

  const checkEntry = setInterval(() => {
    const targetEntry = (window as any).Entry;
    if (targetEntry && targetEntry.variableContainer) {
      clearInterval(checkEntry);

      const Entry = targetEntry;
      log('Entry runtime detected');

      hookEntryEvents(Entry);
      hookVariableSetValue(Entry);
      setTimeout(() => patchExistingVariables(Entry), 2000);
      hookListMethods(Entry);
      listenForRemoteUpdates(Entry);
      startHealthCheckWatcher(Entry);

      window.postMessage({ type: 'ENTRY_READY', projectUrl: window.location.href, projectId: extractProjectId(window.location.href) }, '*');
      log('ENTRY_READY sent to content script');
    }
  }, 500);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

export {};
