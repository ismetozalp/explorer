import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const url = new URL('../js/features/actions.js', import.meta.url);
const sandbox = {
    window: {},
    ExRT: { const: { DISPLAY_TYPES: [] } },
    jsyaml: { load: text => JSON.parse(text) },
    btoa,
    unescape,
    encodeURIComponent,
};
vm.runInNewContext(fs.readFileSync(url, 'utf8'), sandbox, { filename: url.pathname });
const Actions = sandbox.window.ExplorerActions;

function promptHarness(answer, send = () => {}) {
    const calls = { prompts: [], sent: [], closed: [], output: [], pane: [] };
    const instance = Object.create(Actions);
    instance.askPrompt = async (...args) => { calls.prompts.push(args); return answer; };
    instance.askChoice = async (...args) => { calls.prompts.push(args); return answer; };
    instance._pushOutputLine = (_rtab, line) => calls.output.push(line);
    const rtab = { outputLines: calls.pane };
    const channel = {
        send(value) { calls.sent.push(value); send(value); },
        close(reason) { calls.closed.push(reason); },
    };
    return { calls, instance, rtab, channel };
}

const prompt = spec => JSON.stringify(spec);

// Passwords use the masked prompt without carrying a default or multiline
// value, go directly to stdin, and never enter the transcript.
{
    const secret = 'p@ss:word';
    const { calls, instance, rtab, channel } = promptHarness(secret);
    await instance._handleScriptPrompt(rtab, channel, prompt({
        type: 'password', title: 'Archive password', message: 'Enter it',
        default: 'must-not-prefill', multiline: true,
    }));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(calls.prompts)), [[
        'Archive password', 'Enter it', '', { password: true },
    ]]);
    assert.deepStrictEqual(calls.sent, [secret + '\n']);
    assert.deepStrictEqual(calls.output, []);
    assert.deepStrictEqual(calls.pane, []);
}

// An empty password is still a valid answer and sends one newline.
{
    const { calls, instance, rtab, channel } = promptHarness('');
    await instance._handleScriptPrompt(rtab, channel, prompt({ type: 'password' }));
    assert.deepStrictEqual(calls.sent, ['\n']);
    assert.strictEqual(calls.prompts[0][1], 'Enter a password');
    assert.deepStrictEqual(calls.output, []);
    assert.deepStrictEqual(calls.pane, []);
}

// Dismissal cancels the script and sends no input.
{
    const { calls, instance, rtab, channel } = promptHarness(null);
    await instance._handleScriptPrompt(rtab, channel, prompt({ type: 'password' }));
    assert.deepStrictEqual(calls.closed, ['cancelled']);
    assert.deepStrictEqual(calls.sent, []);
}
{
    const { calls, instance, rtab, channel } = promptHarness(null);
    channel.close = () => { throw new Error('channel already closed'); };
    await instance._handleScriptPrompt(rtab, channel, prompt({ type: 'password' }));
    assert.deepStrictEqual(calls.sent, []);
}

// A transport exception must not leak its (potentially sensitive) message.
{
    const secret = 'sensitive-value';
    const { calls, instance, rtab, channel } = promptHarness(secret, () => {
        throw new Error(`transport failed while sending ${secret}`);
    });
    await instance._handleScriptPrompt(rtab, channel, prompt({ type: 'password' }));
    assert.deepStrictEqual(calls.output, ['[explorer] could not send password input\n']);
    assert.deepStrictEqual(calls.pane, []);
    assert.ok(!calls.output.join('').includes(secret));
}

// Existing text and radio prompts continue to write their normal transcript.
{
    const { calls, instance, rtab, channel } = promptHarness('ordinary text');
    await instance._handleScriptPrompt(rtab, channel, prompt({ type: 'text' }));
    assert.deepStrictEqual(calls.sent, ['ordinary text\n']);
    assert.deepStrictEqual(calls.output, ['‹ ordinary text\n']);
}
{
    const { calls, instance, rtab, channel } = promptHarness('production');
    await instance._handleScriptPrompt(rtab, channel, prompt({
        type: 'radio', options: ['staging', 'production'],
    }));
    assert.deepStrictEqual(calls.sent, ['production\n']);
    assert.deepStrictEqual(calls.output, ['‹ production\n']);
}

// Invalid/empty prompt blocks and a radio prompt without choices fail safely.
{
    const { calls, instance, rtab, channel } = promptHarness('unused');
    await instance._handleScriptPrompt(rtab, channel, '{');
    assert.match(calls.pane[0], /^\[explorer\] bad prompt block:/);
}
{
    const { calls, instance, rtab, channel } = promptHarness('unused');
    await instance._handleScriptPrompt(rtab, channel, 'null');
    assert.deepStrictEqual(calls.pane, ['[explorer] empty prompt block\n']);
}
{
    const { calls, instance, rtab, channel } = promptHarness('unused');
    await instance._handleScriptPrompt(rtab, channel, prompt({ type: 'radio' }));
    assert.deepStrictEqual(calls.pane, ['[explorer] radio prompt has no options; aborting\n']);
    assert.deepStrictEqual(calls.closed, ['cancelled']);
}

// A canceled radio choice closes without sending anything.
{
    const { calls, instance, rtab, channel } = promptHarness(null);
    await instance._handleScriptPrompt(rtab, channel, prompt({ type: 'radio', options: ['yes'] }));
    assert.deepStrictEqual(calls.sent, []);
    assert.deepStrictEqual(calls.closed, ['cancelled']);
}
{
    const { calls, instance, rtab, channel } = promptHarness('cancel');
    await instance._handleScriptPrompt(rtab, channel, prompt({ type: 'radio', options: ['yes'] }));
    assert.deepStrictEqual(calls.sent, []);
    assert.deepStrictEqual(calls.closed, ['cancelled']);
}
{
    const { calls, instance, rtab, channel } = promptHarness('production');
    await instance._handleScriptPrompt(rtab, channel, prompt({
        type: 'radio', options: ['staging', 'production'], default: 'production',
    }));
    assert.strictEqual(calls.prompts[0][2][0].variant, 'outline-primary');
    assert.strictEqual(calls.prompts[0][2][1].variant, 'primary');
}
{
    const { calls, instance, rtab, channel } = promptHarness(null);
    await instance._handleScriptPrompt(rtab, channel, prompt({ type: 'text' }));
    assert.deepStrictEqual(calls.sent, []);
    assert.deepStrictEqual(calls.closed, ['cancelled']);
}

// Multi-line answers retain the existing base64 one-line protocol.
{
    const { calls, instance, rtab, channel } = promptHarness('line one\nline two');
    await instance._handleScriptPrompt(rtab, channel, prompt({ type: 'text', multiline: true }));
    const encoded = btoa(unescape(encodeURIComponent('line one\nline two')));
    assert.deepStrictEqual(calls.sent, [encoded + '\n']);
    assert.deepStrictEqual(calls.output, ['‹ line one line two  (multi-line)\n']);
}
{
    const { calls, instance, rtab, channel } = promptHarness('line');
    instance._b64Utf8 = value => value;
    await instance._handleScriptPrompt(rtab, channel, prompt({ type: 'text', multiline: 'true' }));
    assert.deepStrictEqual(calls.sent, ['line\n']);
}

// Ordinary-input transport errors retain their existing diagnostic behavior.
{
    const { calls, instance, rtab, channel } = promptHarness('ordinary text', () => {
        throw new Error('input channel closed');
    });
    await instance._handleScriptPrompt(rtab, channel, prompt({ type: 'text' }));
    assert.deepStrictEqual(calls.output, [
        '‹ ordinary text\n',
        '[explorer] could not send input: input channel closed\n',
    ]);
}

// Display-only messages do not open a prompt or send input.
{
    sandbox.ExRT.const.DISPLAY_TYPES = ['info'];
    const { calls, instance, rtab, channel } = promptHarness('unused');
    instance.toast = (text, level) => calls.output.push(`toast:${level}:${text}\n`);
    await instance._handleScriptPrompt(rtab, channel, prompt({
        type: 'info', text: 'Still working', level: 'success',
    }));
    assert.deepStrictEqual(calls.pane, ['» Still working\n']);
    assert.deepStrictEqual(calls.output, ['toast:success:Still working\n']);
    assert.deepStrictEqual(calls.sent, []);
}

assert.strictEqual(
    Actions._preprocessPromptYaml('message: Running: make foo'),
    'message: "Running: make foo"',
    'plain scalars containing colons are quoted before YAML parsing'
);
assert.strictEqual(
    Actions._preprocessPromptYaml('message: "already quoted: value"'),
    'message: "already quoted: value"',
    'already quoted scalars are preserved'
);
assert.strictEqual(
    Actions._preprocessPromptYaml('options: [dev, staging]\nmultiline: true\n# comment'),
    'options: [dev, staging]\nmultiline: true\n# comment',
    'flow values, booleans, and non-mapping lines are preserved'
);

console.log('actions-prompt-unit: OK');
