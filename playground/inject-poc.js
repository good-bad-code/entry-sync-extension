/**
 * PoC: Entry Runtime Variable Hook - Inject Script
 * 
 * 이 스크립트는 Chrome 확장 프로그램의 content script에 의해
 * playentry.org 페이지의 main world에 <script> 태그로 주입됩니다.
 * 
 * 목적: Entry 전역 객체의 변수/리스트 변경을 감지하고 postMessage로 전달
 * 
 * 사용법: playentry.org/project/{id} 페이지에서 DevTools 콘솔에
 *        이 코드를 붙여넣어 테스트 가능
 */

(function() {
    'use strict';

    // === Configuration ===
    const DEBUG = true;
    const PREFIX = '?!';
    const log = (...args) => DEBUG && console.log('[EntrySync]', ...args);

    // === Helpers ===
    function waitForEntry(maxWait = 10000) {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const check = () => {
                if (window.Entry && window.Entry.Variable && window.Entry.variableContainer) {
                    return resolve(window.Entry);
                }
                if (Date.now() - start > maxWait) {
                    return reject(new Error('Entry not loaded within timeout'));
                }
                setTimeout(check, 200);
            };
            check();
        });
    }

    function isGlobalVariable(variable) {
        return !variable.object_;
    }

    function isSyncVariable(variable) {
        return variable.name_ && variable.name_.startsWith(PREFIX);
    }

    // === Hook: Scalar Variables ===
    function hookVariableSetValue(Entry) {
        const orig = Entry.Variable.prototype.setValue;
        Entry.Variable.prototype.setValue = function(value) {
            // Call original first
            const result = orig.call(this, value);
            
            // Only notify for ?! global variables
            if (isSyncVariable(this) && isGlobalVariable(this)) {
                log(`Variable changed: ${this.name_} = ${this.value_}`);
                window.postMessage({
                    type: 'ENTRY_VAR_CHANGE',
                    name: this.name_,
                    value: this.value_,
                    projectUrl: window.location.href,
                    timestamp: Date.now(),
                }, '*');
            }
            return result;
        };
        log('Hooked: Variable.prototype.setValue');
    }

    // === Hook: List Variables ===
    function hookListMethods(Entry) {
        const methodsToHook = [
            { name: 'setArray', eventType: 'list:replace' },
            { name: 'appendValue', eventType: 'list:append' },
            { name: 'deleteValue', eventType: 'list:delete' },
            { name: 'insertValue', eventType: 'list:insert' },
            { name: 'replaceValue', eventType: 'list:replace' },
        ];

        methodsToHook.forEach(({ name, eventType }) => {
            const orig = Entry.ListVariable.prototype[name];
            if (!orig) {
                log(`Warning: ${name} not found on ListVariable.prototype`);
                return;
            }
            Entry.ListVariable.prototype[name] = function(...args) {
                const result = orig.apply(this, args);
                
                if (isSyncVariable(this) && isGlobalVariable(this)) {
                    log(`List ${name}: ${this.name_}`, args);
                    window.postMessage({
                        type: 'ENTRY_LIST_CHANGE',
                        name: this.name_,
                        operation: name,
                        args: args,
                        array: this.array_,
                        projectUrl: window.location.href,
                        timestamp: Date.now(),
                    }, '*');
                }
                return result;
            };
        });
        log('Hooked: ListVariable methods');
    }

    // === Scan existing ?! variables ===
    function scanSyncVariables(Entry) {
        const container = Entry.variableContainer;
        if (!container) {
            log('Warning: variableContainer not found');
            return { vars: {}, lists: [] };
        }

        const vars = {};
        const lists = [];

        // Scan variables
        (container.variables_ || []).forEach(v => {
            if (isSyncVariable(v) && isGlobalVariable(v)) {
                vars[v.name_] = v.value_;
                log(`Found sync variable: ${v.name_} = ${v.value_}`);
            }
        });

        // Scan lists
        (container.lists_ || []).forEach(l => {
            if (isSyncVariable(l) && isGlobalVariable(l)) {
                const listData = {
                    name: l.name_,
                    array: l.getArray(),
                };
                lists.push(listData);
                log(`Found sync list: ${l.name_} [${listData.array.length} items]`);
            }
        });

        return { vars, lists };
    }

    // === Apply remote variable update ===
    function applyVariableUpdate(Entry, name, value) {
        const container = Entry.variableContainer;
        const variable = (container.variables_ || []).find(v => v.name_ === name);
        if (variable) {
            log(`Applying remote update: ${name} = ${value}`);
            variable.setValue(value);
            return true;
        }
        return false;
    }

    function applyListUpdate(Entry, name, operation, args) {
        const container = Entry.variableContainer;
        const list = (container.lists_ || []).find(l => l.name_ === name);
        if (!list) return false;

        log(`Applying remote list ${operation}: ${name}`, args);
        switch (operation) {
            case 'setArray':       list.setArray(args[0]); break;
            case 'appendValue':    list.appendValue(args[0]); break;
            case 'deleteValue':    list.deleteValue(args[0]); break;
            case 'insertValue':    list.insertValue(args[0], args[1]); break;
            case 'replaceValue':   list.replaceValue(args[0], args[1]); break;
        }
        return true;
    }

    // === Listen for remote updates from content script ===
    function listenForRemoteUpdates(Entry) {
        window.addEventListener('message', (event) => {
            if (event.source !== window) return;
            const msg = event.data;
            
            switch (msg.type) {
                case 'APPLY_VAR_UPDATE':
                    applyVariableUpdate(Entry, msg.name, msg.value);
                    break;
                case 'APPLY_LIST_UPDATE':
                    applyListUpdate(Entry, msg.name, msg.operation, msg.args);
                    break;
            }
        });
        log('Listening for remote updates');
    }

    // === Main ===
    async function init() {
        try {
            const Entry = await waitForEntry();
            log('Entry runtime detected');

            // 1. Hook variable changes
            hookVariableSetValue(Entry);
            hookListMethods(Entry);

            // 2. Scan existing ?! variables
            const scanResult = scanSyncVariables(Entry);
            
            // 3. Send initial state to content script
            window.postMessage({
                type: 'ENTRY_VARS_INIT',
                vars: scanResult.vars,
                lists: scanResult.lists,
                projectUrl: window.location.href,
            }, '*');

            // 4. Start listening for remote updates
            listenForRemoteUpdates(Entry);

            log('Init complete. Syncing variables:', scanResult.vars, scanResult.lists);
        } catch (e) {
            console.error('[EntrySync] Init failed:', e);
        }
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
