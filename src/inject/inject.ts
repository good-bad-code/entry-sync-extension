const PREFIX = '?!';

function log(...args: unknown[]) {
  console.log('[EntrySync]', ...args);
}

function isGlobalVariable(v: any): boolean {
  return v && !v.object_;
}

function isSyncVariable(v: any): boolean {
  // "?!" (bare prefix) is the health-check variable — NOT synced
  // "?!name" variables/lists ARE synced
  return v && v.name_ && v.name_.startsWith(PREFIX) && v.name_ !== PREFIX;
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

function hookEntryEvents(Entry: any) {
  Entry.addEventListener('blockExecute', (blockView: any) => {
    if (!blockView || !blockView.block) return;
    const block = blockView.block;
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
      log(`Block executing: ${type}`, params);
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
      value = Math.floor(Math.random() * 9000) + 1000;
      log(`?! health check: converting 0 to ${value}`);
    }

    // ALLOW+SEND: call orig first, then notify
    const result = orig.call(this, value);

    // Send operation (only if sync variable and not applying remote)
    if (isSyncVariable(this) && isGlobalVariable(this) && !applyingRemoteVar) {
      window.postMessage(
        {
          type: 'ENTRY_VAR_CHANGE',
          name: this.name_,
          value: this.value_,
          timestamp: Date.now(),
        },
        '*'
      );
      notifyParent('var', this.name_, this.value_);
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
      // ALLOW+SEND: call orig first, then notify
      const result = orig.apply(this, args);

      // ?! list health check: auto-reset 0 to random
      if (this.name_ === PREFIX) {
        const arr = extractArray(this);
        if (arr.length === 1 && arr[0] === 0) {
          const newValue = Math.floor(Math.random() * 9000) + 1000;
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

      if (isSyncVariable(this) && isGlobalVariable(this) && !applyingRemoteList) {
        window.postMessage(
          {
            type: 'ENTRY_LIST_CHANGE',
            name: this.name_,
            operation: name,
            args: args,
            timestamp: Date.now(),
          },
          '*'
        );
        notifyParent('list', this.name_, extractArray(this));
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
    const proto = items.length > 0 ? Object.getPrototypeOf(items[0]) : listProto;
    patchExistingInstances(this, proto);
    return result;
  };

  log(`Hooked: ListVariable.prototype methods (ALLOW+SEND pattern, ${methodsToHook.join(', ')})`);
}

function patchExistingInstances(lists: any[], proto: any) {
  if (!lists || !proto) return;
  for (let i = 0; i < lists.length; i++) {
    const inst = lists[i];
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

function processPendingUpdates(Entry: any) {
  if (pendingUpdates.length === 0) return;
  const updates = pendingUpdates.splice(0);
  log(`Processing ${updates.length} pending updates`);
  for (const update of updates) {
    if (update.type === 'APPLY_VAR_UPDATE') {
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
          const v = (Entry.variableContainer.variables_ || []).find((x: any) => x.name_ === name);
          if (v) { v.value_ = value; if (v.view_?.updateView) v.view_.updateView(); notifyParent('var', name, value); }
        }
        for (const list of update.lists || []) {
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
      } finally { applyingRemoteList = false; applyingRemoteVar = false; }
    }
  }
}

function listenForRemoteUpdates(Entry: any) {
  window.addEventListener('message', (event) => {
    const msg = event.data;

    // Cross-frame messages (from iframe to parent)
    if (event.source !== window) {
      if (msg.type === 'ENTRY_SYNC_UPDATE') { handleSyncUpdate(Entry, msg); }
      return;
    }

    // Self messages — queue if blocks are executing
    if (syncBlockCount > 0 &&
        (msg.type === 'APPLY_VAR_UPDATE' || msg.type === 'APPLY_LIST_UPDATE' || msg.type === 'INIT_SYNC_RESULT')) {
      pendingUpdates.push(msg);
      return;
    }

    if (msg.type === 'APPLY_VAR_UPDATE') {
      applyingRemoteVar = true;
      try {
        const v = (Entry.variableContainer.variables_ || []).find(
          (x: any) => x.name_ === msg.name
        );
        if (!v) return;
        log(`APPLY_VAR_UPDATE: ${msg.name} = ${msg.value}`);
        // Direct assignment — avoids setValue hook re-entry
        v.value_ = msg.value;
        if (v.view_?.updateView) v.view_.updateView();
        notifyParent('var', msg.name, msg.value);
      } finally {
        applyingRemoteVar = false;
      }
    } else if (msg.type === 'APPLY_LIST_UPDATE') {
      applyingRemoteList = true;
      try {
        const l = (Entry.variableContainer.lists_ || []).find(
          (x: any) => x.name_ === msg.name
        );
        if (!l) return;
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
      // Apply DB values from INIT_SYNC_RESULT
      applyingRemoteVar = true;
      applyingRemoteList = true;
      try {
        for (const [name, value] of Object.entries(msg.vars || {})) {
          const v = (Entry.variableContainer.variables_ || []).find(
            (x: any) => x.name_ === name
          );
          if (v) {
            v.value_ = value;
            if (v.view_?.updateView) v.view_.updateView();
            notifyParent('var', name, value);
          }
        }
        for (const list of msg.lists || []) {
          const l = (Entry.variableContainer.lists_ || []).find(
            (x: any) => x.name_ === list.name
          );
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
      } finally {
        applyingRemoteList = false;
        applyingRemoteVar = false;
      }
    }
  });
}

function startHealthCheckWatcher(Entry: any) {
  setInterval(() => {
    const healthVar = (Entry.variableContainer.variables_ || []).find(
      (v: any) => v.name_ === PREFIX
    );
    if (healthVar && healthVar.value_ === 0) {
      const newValue = Math.floor(Math.random() * 9000) + 1000;
      log(`?! health check (var via watcher): 0 detected, setting to ${newValue}`);
      healthVar.value_ = newValue;
      if (healthVar.view_?.updateView) healthVar.view_.updateView();
      (Entry as any).requestUpdate = true;
      if (Entry.stage?.update) Entry.stage.update();
    }
    // Check ?! as list
    const healthList = (Entry.variableContainer.lists_ || []).find(
      (l: any) => l.name_ === PREFIX
    );
    if (healthList) {
      const arr = extractArray(healthList);
      if (arr.length === 1 && arr[0] === 0) {
        const newValue = Math.floor(Math.random() * 9000) + 1000;
        log(`?! health check (list via watcher): 0 detected, resetting to ${newValue}`);
        healthList.array_ = [{ data: newValue }];
        if (healthList.view_) {
          if (typeof healthList.view_.updateView === 'function') healthList.view_.updateView();
          if (typeof healthList.view_.setList === 'function') healthList.view_.setList(healthList.array_);
        }
        (Entry as any).requestUpdate = true;
        if (Entry.stage?.update) Entry.stage.update();
      }
    }
  }, 1000);
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
      hookListMethods(Entry);
      listenForRemoteUpdates(Entry);
      startHealthCheckWatcher(Entry);

      window.postMessage({ type: 'ENTRY_READY', projectUrl: window.location.href }, '*');
      log('ENTRY_READY sent to content script');
    }
  }, 500);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
