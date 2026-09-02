import { makeDialogDraggable } from './draggableDialog.js';

function defaultValue(schema = {}) {
  if (schema.default !== undefined) return schema.default;
  if (schema.type === 'boolean') return false;
  return '';
}

export function coerceToolArguments(schema = {}, values = {}) {
  const args = {};
  const required = new Set(schema.required || []);
  for (const [name, property = {}] of Object.entries(schema.properties || {})) {
    const rawValue = values[name];
    if (property.type === 'boolean') {
      args[name] = Boolean(rawValue);
      continue;
    }
    if (rawValue === '' || rawValue === undefined || rawValue === null) {
      if (required.has(name)) throw new Error(`${name} is required.`);
      continue;
    }
    if (property.type === 'integer' || property.type === 'number') {
      const value = Number(rawValue);
      if (!Number.isFinite(value)) throw new Error(`${name} must be a number.`);
      if (property.type === 'integer' && !Number.isInteger(value)) {
        throw new Error(`${name} must be a whole number.`);
      }
      if (property.minimum !== undefined && value < property.minimum) {
        throw new Error(`${name} must be at least ${property.minimum}.`);
      }
      if (property.maximum !== undefined && value > property.maximum) {
        throw new Error(`${name} must be at most ${property.maximum}.`);
      }
      args[name] = value;
      continue;
    }
    if (property.type === 'array') {
      let value;
      try {
        value = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
      } catch {
        throw new Error(`${name} must be valid JSON.`);
      }
      if (!Array.isArray(value)) throw new Error(`${name} must be a JSON array.`);
      if (property.minItems !== undefined && value.length < property.minItems) {
        throw new Error(`${name} needs at least ${property.minItems} item(s).`);
      }
      if (property.maxItems !== undefined && value.length > property.maxItems) {
        throw new Error(`${name} allows at most ${property.maxItems} item(s).`);
      }
      args[name] = value;
      continue;
    }
    const value = String(rawValue);
    if (Array.isArray(property.enum) && !property.enum.includes(value)) {
      throw new Error(`${name} must be one of: ${property.enum.join(', ')}.`);
    }
    args[name] = value;
  }
  return args;
}

export class SpiderManualToolPanel {
  constructor(controller) {
    this.controller = controller;
    this.catalog = controller.getToolCatalog();
    this.catalogByName = new Map(this.catalog.map((tool) => [tool.name, tool]));
    this.lastAvailabilitySignature = '';
    this.executing = false;

    document.getElementById('spider-manual-tool-panel')?.remove();
    this.form = document.createElement('form');
    this.form.id = 'spider-manual-tool-panel';
    this.form.setAttribute('aria-label', 'Manual WebMCP tool console');
    this.form.innerHTML = `
      <div class="spider-dialog-grip spider-dialog-header"><span>MANUAL TOOL CONSOLE</span><button type="button" class="spider-dialog-toggle" aria-label="Minimize dialog" title="Minimize dialog">▾</button></div>
      <label class="spider-manual-tool-picker">
        <span>METHOD</span>
        <select name="tool" aria-label="Spider method"></select>
      </label>
      <div class="spider-manual-fields"></div>
      <button type="submit">EXECUTE</button>
      <output aria-live="polite">READY</output>
    `;
    this.select = this.form.querySelector('select');
    this.fields = this.form.querySelector('.spider-manual-fields');
    this.button = this.form.querySelector('button');
    this.status = this.form.querySelector('output');
    this.dialogToggle = this.form.querySelector('.spider-dialog-toggle');
    this.dialogToggle.addEventListener('pointerdown', (event) => event.stopPropagation());
    this.dialogToggle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const minimized = this.form.classList.toggle('is-minimized');
      this.dialogToggle.textContent = minimized ? '▴' : '▾';
      this.dialogToggle.setAttribute('aria-label', minimized ? 'Maximize dialog' : 'Minimize dialog');
    });
    this.onSelect = () => this.renderFields();
    this.onSubmit = (event) => this.execute(event);
    this.select.addEventListener('change', this.onSelect);
    this.form.addEventListener('submit', this.onSubmit);
    for (const eventName of ['keydown', 'keyup']) {
      this.form.addEventListener(eventName, (event) => event.stopPropagation());
    }
    document.getElementById('app')?.append(this.form);
    this.removeDrag = makeDialogDraggable(this.form, this.form.querySelector('.spider-dialog-grip'));
    this.update(true);

    this.controller.ready
      .then((registered) => {
        if (!registered || !this.controller.canConsumeWebMcpTools()) {
          this.setUnavailable('WEBMCP UNAVAILABLE');
        }
      })
      .catch(() => this.setUnavailable('WEBMCP UNAVAILABLE'));
  }

  update(force = false) {
    const available = new Set(this.controller.getAvailableTools().map((tool) => tool.name));
    const signature = JSON.stringify([
      [...available],
      this.controller.activeToolName,
      this.controller.actionQueue?.[0]?.tool,
    ]);
    if (!force && signature === this.lastAvailabilitySignature) return;
    this.lastAvailabilitySignature = signature;
    const previous = this.select.value;
    const makeOption = (tool) => {
        const option = document.createElement('option');
        option.value = tool.name;
        option.textContent = available.has(tool.name) ? tool.name : `${tool.name} — unavailable`;
        option.disabled = !available.has(tool.name);
        return option;
      };
    // Inspection is used internally by planning and diagnostics, but is not
    // an actionable manual command, so keep it out of the picker UI.
    const options = this.catalog
      .filter((tool) => tool.name !== 'inspect_game_world')
      .map(makeOption);
    this.select.replaceChildren(...options);
    if (available.has(previous)) this.select.value = previous;
    else this.select.value = available.has('move_spider')
      ? 'move_spider'
      : this.catalog.find((tool) => available.has(tool.name))?.name || '';
    this.renderFields();
  }

  renderFields() {
    const tool = this.catalogByName.get(this.select.value);
    const schema = tool?.input_schema || { properties: {} };
    const required = new Set(schema.required || []);
    const previousTarget = this.fields.querySelector('[name="target"]')?.value;
    const target = this.moveTarget || previousTarget || 'direction';
    const visibleProperties = Object.entries(schema.properties || {}).filter(([name]) => {
      if (tool?.name !== 'move_spider' || name === 'target') return true;
      if (target === 'edge') return name === 'side';
      if (target === 'tree') return name === 'tree';
      return name === 'direction' || name === 'duration_ms';
    });
    const fields = visibleProperties.map(([name, property]) => {
      const label = document.createElement('label');
      label.className = 'spider-manual-field';
      const caption = document.createElement('span');
      caption.textContent = `${name}${required.has(name) ? ' *' : ''}`;
      label.append(caption, this.createInput(name, property, required.has(name)));
      if (property.description) label.title = property.description;
      return label;
    });
    if (!fields.length) {
      const empty = document.createElement('p');
      empty.className = 'spider-manual-empty';
      empty.textContent = 'NO PARAMETERS';
      fields.push(empty);
    }
    this.fields.replaceChildren(...fields);
    const targetInput = this.fields.querySelector('[name="target"]');
    if (targetInput) {
      targetInput.value = target;
      targetInput.addEventListener('change', () => {
        this.moveTarget = targetInput.value;
        this.renderFields();
      });
    }
    this.status.value = tool?.description || 'READY';
    this.status.title = tool?.description || '';
  }

  createInput(name, schema = {}, required = false) {
    let input;
    if (Array.isArray(schema.enum)) {
      input = document.createElement('select');
      if (!required && schema.default === undefined) {
        input.append(new Option('—', ''));
      }
      for (const value of schema.enum) input.append(new Option(value, value));
    } else {
      input = document.createElement(schema.type === 'array' ? 'textarea' : 'input');
      if (schema.type === 'array') {
        input.rows = 3;
        input.placeholder = '[]';
      } else if (schema.type === 'boolean') {
        input.type = 'checkbox';
      } else if (schema.type === 'integer' || schema.type === 'number') {
        input.type = 'number';
        if (schema.minimum !== undefined) input.min = String(schema.minimum);
        if (schema.maximum !== undefined) input.max = String(schema.maximum);
        input.step = schema.type === 'integer' ? '1' : 'any';
      } else {
        input.type = 'text';
      }
    }
    input.name = name;
    input.required = required;
    const initial = defaultValue(schema);
    if (schema.type === 'boolean') input.checked = Boolean(initial);
    else input.value = String(initial);
    return input;
  }

  readValues() {
    return Object.fromEntries([...this.fields.querySelectorAll('input, select, textarea')].map((input) => [
      input.name,
      input.type === 'checkbox' ? input.checked : input.value,
    ]));
  }

  async execute(event) {
    event.preventDefault();
    if (this.executing || !this.select.value) return;
    const tool = this.catalogByName.get(this.select.value);
    try {
      const args = coerceToolArguments(tool.input_schema, this.readValues());
      this.executing = true;
      this.button.disabled = true;
      this.status.value = `RUNNING ${tool.name}…`;
      const result = await this.controller.executeWebMcpAction({ tool: tool.name, arguments: args });
      const resultText = JSON.stringify(result);
      this.status.value = `RESULT: ${resultText}`;
      this.status.title = resultText;
    } catch (error) {
      this.status.value = `ERROR: ${error?.message || error}`;
      this.status.title = String(error?.message || error);
    } finally {
      this.executing = false;
      this.button.disabled = false;
    }
  }

  setUnavailable(message) {
    this.select.disabled = true;
    this.button.disabled = true;
    this.status.value = message;
  }

  destroy() {
    this.select.removeEventListener('change', this.onSelect);
    this.form.removeEventListener('submit', this.onSubmit);
    this.removeDrag();
    this.form.remove();
  }
}
