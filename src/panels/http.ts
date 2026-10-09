export async function limitedText(response: Response, max = 1048576): Promise<string> {
    if (!response.body)
        return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            size += value.byteLength;
            if (size > max)
                throw new Error('panel_response_too_large');
            chunks.push(value);
        }
        const all = new Uint8Array(size);
        let offset = 0;
        for (const c of chunks) {
            all.set(c, offset);
            offset += c.byteLength;
        }
        return new TextDecoder().decode(all);
    }
    finally {
        await reader.cancel().catch(() => undefined);
    }
}
