import crypto from 'crypto';

function stripCodeFences(text) {
    const trimmed = String(text || '').trim();
    const fence = trimmed.match(/^```(?:json|xml|dsml)?\s*([\s\S]*?)\s*```$/i);
    return fence ? fence[1].trim() : trimmed;
}

function normalizeToolArgumentValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed) return '';
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try { return JSON.parse(trimmed); } catch { /* keep original string */ }
    }
    return value.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
}

function serializeToolArguments(rawArgs) {
    if (typeof rawArgs === 'string') {
        const trimmed = rawArgs.trim();
        if (!trimmed) return '{}';
        try { return JSON.stringify(JSON.parse(trimmed)); } catch { return rawArgs; }
    }
    return JSON.stringify(rawArgs || {});
}

function normalizeToolCalls(calls) {
    if (!Array.isArray(calls) || calls.length === 0) return null;
    const normalized = calls.map((call, index) => {
        const name = call?.name || call?.tool || call?.function?.name;
        const rawArgs = call?.arguments ?? call?.args ?? call?.input ?? call?.function?.arguments ?? {};
        if (!name) return null;
        return {
            id: call.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
            type: 'function',
            function: { name, arguments: serializeToolArguments(rawArgs) },
            index: Number.isInteger(call.index) ? call.index : index
        };
    }).filter(Boolean);
    return normalized.length > 0 ? normalized : null;
}

function parseJsonToolCalls(content) {
    let text = stripCodeFences(content);
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) text = fenced[1].trim();

    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) text = text.slice(first, last + 1);

    const parseAttempts = [text];
    if (/^\s*\{\s*"tool_calls"\s*:\s*\[\s*\{/.test(text) && /\}\]\}\s*$/.test(text)) {
        parseAttempts.push(text.replace(/\}\]\}\s*$/, '}}]}'));
    }
    if (/^\s*\{\s*"tool_calls"\s*:\s*\[/.test(text) && !/\}\s*$/.test(text)) {
        parseAttempts.push(text + '}');
    }

    for (const candidate of parseAttempts) {
        try {
            const parsed = JSON.parse(candidate);
            let calls = null;
            if (Array.isArray(parsed.tool_calls)) calls = parsed.tool_calls;
            else if (parsed.function_call || parsed.tool_call) calls = [parsed.function_call || parsed.tool_call];
            else if (parsed.name || parsed.tool) calls = [parsed];
            const normalized = normalizeToolCalls(calls);
            if (normalized) return normalized;
        } catch {
            // try next repair candidate / parser family
        }
    }
    return null;
}

function normalizeDsmlTags(content) {
    let text = stripCodeFences(content)
        .replace(/[〈《]/g, '<')
        .replace(/[〉》]/g, '>')
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/<!\[CDATA\[/g, '<![CDATA[')
        .replace(/\]\]>/g, ']]>');

    return text.replace(/<([^<>]+)>/g, (full, rawInner) => {
        const inner = rawInner.trim();
        const closing = inner.startsWith('/');
        const body = (closing ? inner.slice(1) : inner).trim();
        const searchable = body.replace(/[|｜！!、,;:※\u0002]+/g, ' ');
        const match = searchable.match(/(tool[_\s-]*calls|toolcalls|invoke|parameter)([\s\S]*)/i);
        if (!match) return full;
        const compactName = match[1].toLowerCase().replace(/[^a-z]/g, '');
        const tagName = compactName === 'toolcalls' ? 'tool_calls' : compactName;
        let attrs = closing ? '' : (match[2] || '')
            .replace(/[|｜！!、,;:※\u0002\s]+$/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        attrs = attrs ? ` ${attrs}` : '';
        return `<${closing ? '/' : ''}${tagName}${attrs}>`;
    });
}

function extractXmlAttr(attrs, name) {
    const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
    const match = String(attrs || '').match(re);
    return match ? (match[1] ?? match[2] ?? match[3] ?? '') : '';
}

function parseDsmlToolCalls(content) {
    const text = normalizeDsmlTags(content);
    let wrapperMatch = text.match(/<tool_calls\b[^>]*>([\s\S]*?)<\/tool_calls>/i);
    if (!wrapperMatch && /<\/tool_calls>\s*$/i.test(text) && /<invoke\b/i.test(text)) {
        // DS2API-style narrow repair: tolerate a missing opening wrapper only
        // when a closing tool_calls wrapper is present and complete invokes exist.
        wrapperMatch = [`<tool_calls>${text}`, text.replace(/<\/tool_calls>\s*$/i, '')];
    }
    if (!wrapperMatch) return null;

    const body = wrapperMatch[1];
    const invokeRe = /<invoke\b([^>]*)>([\s\S]*?)<\/invoke>/gi;
    const calls = [];
    let invokeMatch;
    while ((invokeMatch = invokeRe.exec(body)) !== null) {
        const name = extractXmlAttr(invokeMatch[1], 'name');
        if (!name) continue;
        const invokeBody = invokeMatch[2];
        const args = {};
        const paramRe = /<parameter\b([^>]*)>([\s\S]*?)<\/parameter>/gi;
        let paramMatch;
        while ((paramMatch = paramRe.exec(invokeBody)) !== null) {
            const paramName = extractXmlAttr(paramMatch[1], 'name');
            if (!paramName) continue;
            let value = paramMatch[2].trim();
            value = value.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/i, '$1');
            args[paramName] = normalizeToolArgumentValue(value);
        }
        if (/<parameter\b/i.test(invokeBody) && Object.keys(args).length === 0) return null;
        calls.push({ name, arguments: args });
    }

    if (/<invoke\b/i.test(body) && calls.length === 0) return null;
    return normalizeToolCalls(calls);
}

export function parseToolCallJson(content) {
    if (typeof content !== 'string') return null;
    return parseJsonToolCalls(content) || parseDsmlToolCalls(content);
}
