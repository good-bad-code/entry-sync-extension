# Entry Runtime Analysis

Source: entrylabs/entryjs (develop branch)
Analysis Date: 2026-06-11

## 1. Entry Global Object

- `window.Entry` is the global entry point
- Registered via `global.Entry = Entry` and `window.Entry = Entry`
- All modules are loaded via `require()` calls and attached to `Entry` namespace

## 2. Variable System (src/class/variable/)

### Variable class (variable.js)
**Constructor**: `new Variable({ name, id, variableType, object, isCloud, isRealTime, value, ... })`

**Key Properties**:
| Property | Type | Description |
|----------|------|-------------|
| `name_` | string | Variable name (e.g., "?!score") |
| `id_` | string | Unique identifier |
| `value_` | number\|string | Current value |
| `type` | string | "variable" (default), "list", "timer", "answer", "stt", "slide" |
| `object_` | string\|null | Owner object ID (null = global) |
| `isCloud_` | boolean | Cloud sync flag |
| `isRealTime_` | boolean | Realtime sync flag |
| `visible_` | boolean | Stage visibility |

**Key Methods to Hook**:
| Method | Returns | Side Effects | Hook Target |
|--------|---------|-------------|-------------|
| `setValue(value)` | undefined | Updates `value_`, calls `updateView()`, sets `Entry.requestUpdateTwice = true` | **PRIMARY** - value change detection |
| `getValue()` | `value_` | None | Read current value |
| `setName(name)` | undefined | Updates `name_` | Optional - name change |
| `syncModel_(model)` | undefined | Calls `setValue`, `setName`, `setX`, `setY`, `setVisible` | Optional - model sync |

### ListVariable class (listVariable.js) extends Variable
**Additional Properties**:
| Property | Type | Description |
|----------|------|-------------|
| `array_` | Array<{data: any}> | List items array |
| `width_`, `height_` | number | Display dimensions |
| `scrollPosition` | number | Scroll position |

**Key Methods to Hook**:
| Method | Description | Hook Target |
|--------|-------------|-------------|
| `setArray(array)` | Replace entire array | **PRIMARY** - list replace |
| `appendValue(value)` | Push `{data: value}` to end | **PRIMARY** - list append |
| `deleteValue(index)` | Splice at index-1 | **PRIMARY** - list delete |
| `insertValue(index, data)` | Splice insert at index-1 | **PRIMARY** - list insert |
| `replaceValue(index, data)` | Replace data at index-1 | **PRIMARY** - list replace |
| `getArray()` | Return array_ | Read current list |

## 3. VariableContainer (variable_container.js)

**Access**: `Entry.variableContainer`

**Key Properties**:
| Property | Type | Description |
|----------|------|-------------|
| `variables_` | Array<Variable> | All scalar variables |
| `lists_` | Array<ListVariable> | All list variables |
| `messages_` | Array | Message variables |
| `viewMode_` | string | Current filter mode |

**Key Methods**:
| Method | Description |
|--------|-------------|
| `select(object)` | Select a variable/list in UI |
| `updateList()` | Refresh variable list display |
| `updateVariableTab()` | Render variable tab |
| `updateListTab()` | Render list tab |

## 4. Execution System (playground/executors.js)

**Executor class**:
- Runs blocks for a specific entity (sprite)
- `executor.scope` - current execution scope
- `scoperun(entity)` - executes the current block's logic
- `Entry.dispatchEvent('blockExecute', blockView)` - fired before each block execution
- `Entry.dispatchEvent('blockExecuteEnd', blockView)` - fired after block execution

**Events**:
| Event | Fires When | Payload |
|-------|-----------|---------|
| `blockExecute` | Block is about to execute | `blockView` (block DOM) |
| `blockExecuteEnd` | Block execution ends | `blockView` |
| `workspaceChangeMode` | Workspace mode changes | - |
| `changeFuncVariableListSize` | Function variable list size changes | - |

## 5. Hooking Strategy

### For Scalar Variables:
```javascript
// Wrap Entry.Variable.prototype.setValue
const origSetValue = Entry.Variable.prototype.setValue;
Entry.Variable.prototype.setValue = function(value) {
    const result = origSetValue.call(this, value);
    if (this.name_ && this.name_.startsWith('?!')) {
        // Notify content script
        window.postMessage({
            type: 'ENTRY_VAR_CHANGE',
            name: this.name_,
            value: this.value_,
        }, '*');
    }
    return result;
};
```

### For List Variables:
```javascript
const methods = ['setArray', 'appendValue', 'deleteValue', 'insertValue', 'replaceValue'];
methods.forEach(methodName => {
    const original = Entry.ListVariable.prototype[methodName];
    Entry.ListVariable.prototype[methodName] = function(...args) {
        const result = original.apply(this, args);
        if (this.name_ && this.name_.startsWith('?!')) {
            window.postMessage({
                type: 'ENTRY_LIST_CHANGE',
                name: this.name_,
                operation: methodName,
                args: args,
                array: this.array_,
            }, '*');
        }
        return result;
    };
});
```

### For Initial Scan:
```javascript
function scanVariables() {
    const container = Entry.variableContainer;
    const vars = {};
    const lists = {};
    
    // Scan scalar variables
    container.variables_.forEach(v => {
        if (v.name_ && v.name_.startsWith('?!') && !v.object_) {
            vars[v.name_] = v.value_;
        }
    });
    
    // Scan list variables
    container.lists_.forEach(l => {
        if (l.name_ && l.name_.startsWith('?!') && !l.object_) {
            lists[l.name_] = l.getArray();
        }
    });
    
    return { vars, lists };
}
```

## 6. Key Findings Summary

1. **Global variables**: `variable.object_ === null` → global (sprite scope if object_ is set)
2. **Value storage**: Variables store raw value in `value_`, lists store `[{data: value}, ...]` in `array_`
3. **Hook timing**: `setValue()` is called AFTER the value is computed by the block execution → ideal timing for sync
4. **No built-in "variable change" event**: Need monkey-patch approach
5. **Entry events** (`blockExecute`, `blockExecuteEnd`) only fire for block execution, not for variable changes from other sources
6. **Canvas rendering**: Variable display is canvas-based (via GEHelper/PIXI), not DOM
