require('dotenv').config();
const { Client, GatewayIntentBits, AttachmentBuilder } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

/**
 * Strip absolute file paths from error output so the server directory
 * structure is never exposed to Discord users.
 */
const sanitizeError = (str) => {
    if (!str) return 'Unknown error';
    // Remove Windows absolute paths (C:\Users\...\file.js:line:col)
    str = str.replace(/[A-Za-z]:[\\][^\s\n'"]+/g, (m) => {
        const parts = m.replace(/:\d+:\d+\)?$/, '').split(/[\\/]/);
        return parts[parts.length - 1] || m;
    });
    // Remove Unix absolute paths (/home/... /root/... /var/...)
    str = str.replace(/\/(?:home|root|Users|var|tmp|opt)\/[^\s\n'"]+/g, (m) => {
        const parts = m.replace(/:\d+:\d+\)?$/, '').split('/');
        return parts[parts.length - 1] || m;
    });
    // Remove 'at <anon> (path:line)' stack frames entirely
    str = str.split('\n')
        .filter(line => !line.trim().startsWith('at ') || line.includes('Error:'))
        .join('\n')
        .trim();
    return str.substring(0, 1800);
};

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
    ],
    partials: [
        1, // Partials.Channel (needed for DMs)
    ]
});

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // Remove this log later, just for debugging!
    console.log(`Received message from ${message.author.tag}: ${message.content}`);

    if (message.content.startsWith('.deobf')) {
        let fileUrl = null;

        const VALID_EXTS = ['.lua', '.luau', '.txt'];
        const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB

        const isValidExt = (name) => VALID_EXTS.some(ext => name.endsWith(ext));

        // Extract any link passed directly via command
        const args = message.content.split(' ');
        const link = args.length > 1 ? args[1] : null;

        // ── 1. Check the invoking message's attachments
        if (message.attachments.size > 0) {
            const attachment = message.attachments.first();
            if (isValidExt(attachment.name)) {
                if (attachment.size > MAX_FILE_BYTES) {
                    return message.reply(`File is too large (max 20 MB). Your file is ${(attachment.size / 1024 / 1024).toFixed(1)} MB.`);
                }
                fileUrl = attachment.url;
            } else {
                return message.reply(`Please provide a \`${VALID_EXTS.join('\`/\`')}\` file.`);
            }
        }
        // ── 2. Check if the user replied to a message with an attachment
        else if (message.reference) {
            try {
                const refMsg = await message.channel.messages.fetch(message.reference.messageId);
                if (refMsg.attachments.size > 0) {
                    const attachment = refMsg.attachments.first();
                    if (isValidExt(attachment.name)) {
                        if (attachment.size > MAX_FILE_BYTES) {
                            return message.reply(`File is too large (max 20 MB).`);
                        }
                        fileUrl = attachment.url;
                    } else {
                        return message.reply(`The replied-to message has no \`${VALID_EXTS.join('\`/\`')}\` attachment.`);
                    }
                } else if (link) {
                    fileUrl = link;
                } else {
                    return message.reply("The replied-to message has no file attachment.");
                }
            } catch (err) {
                if (link) fileUrl = link;
                else return message.reply("Could not fetch the replied-to message.");
            }
        }
        // ── 3. Use a provided link
        else if (link) {
            fileUrl = link;
        } else {
            return message.reply(
                "**Usage:**\n" +
                "• Attach a `.lua`/`.luau`/`.txt` file and run `.deobf`\n" +
                "• Reply to a message with a file and run `.deobf`\n" +
                "• Run `.deobf <raw_url>`"
            );
        }

        // ── Start processing
        const statusMsg = await message.reply("Deobfuscating...");
        const startTime = Date.now();

        // Keep Discord typing indicator alive during long jobs
        let typingInterval = null;
        try {
            await message.channel.sendTyping();
            typingInterval = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
        } catch { /* non-fatal */ }

        const fileId = crypto.randomUUID().replace(/-/g, '');
        const inputFile = path.join(__dirname, `temp_${fileId}_in.lua`);
        const outputFile = path.join(__dirname, `temp_${fileId}_out.lua`);

        try {
            // Download the file
            const response = await fetch(fileUrl);
            if (!response.ok) {
                return statusMsg.edit("Failed to download the file.");
            }
            const arrayBuffer = await response.arrayBuffer();

            // Final byte-size guard for URL-sourced files
            if (arrayBuffer.byteLength > MAX_FILE_BYTES) {
                return statusMsg.edit(`File is too large (${(arrayBuffer.byteLength / 1024 / 1024).toFixed(1)} MB). Max is 20 MB.`);
            }

            await fs.writeFile(inputFile, Buffer.from(arrayBuffer));

            try {
                // Increase maxBuffer and Node memory limit in case the file is huge
                await execAsync(
                    `node --max-old-space-size=4096 "${path.join(__dirname, 'main.js')}" "${inputFile}" "${outputFile}"`,
                    { maxBuffer: 1024 * 1024 * 50 }
                );

                // Read the output and send it
                await fs.access(outputFile);
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                const attachment = new AttachmentBuilder(outputFile, { name: 'deobfuscated.lua' });

                await statusMsg.edit(`Deobfuscated in ${elapsed}s`);
                await message.reply({ files: [attachment] });

            } catch (deobfErr) {
                console.error(deobfErr);
                // Extract the actual error message and sanitize paths
                const raw = deobfErr.stderr || deobfErr.stdout || String(deobfErr.message || deobfErr);
                const clean = sanitizeError(raw);
                await statusMsg.edit(`Deobfuscation failed\n\`\`\`\n${clean}\n\`\`\``);
            }

        } catch (e) {
            console.error(e);
            await statusMsg.edit(`An error occurred: ${e.message}`);
        } finally {
            if (typingInterval) clearInterval(typingInterval);
            // Cleanup temp files
            for (const p of [inputFile, outputFile]) {
                try {
                    await fs.unlink(p);
                } catch (cleanupErr) {
                    // Ignore missing files
                    if (cleanupErr.code !== 'ENOENT') {
                        console.error(`Cleanup failed for ${p}:`, cleanupErr);
                    }
                }
            }
        }
    }
    if (message.content === '.help' || message.content.startsWith('.help ')) {
        return message.reply(
            "**Prometheus Deobfuscator — Commands**\n" +
            "```\n" +
            ".deobf          Deobfuscate a Prometheus-obfuscated Lua script.\n" +
            "                Attach a .lua / .luau / .txt file, reply to one,\n" +
            "                or pass a raw URL: .deobf <url>\n" +
            "\n" +
            ".upload         Upload any file to Pastefy for easy sharing.\n" +
            "                Attach a file, reply to one, or pass a URL.\n" +
            "\n" +
            ".help           Show this message.\n" +
            "```"
        );
    }
    if (message.content.startsWith('.upload')) {

        let fileUrl = null;
        let fileName = 'paste.lua';

        // Same attachment/reply resolution as .deobf
        if (message.attachments.size > 0) {
            const att = message.attachments.first();
            fileUrl = att.url;
            fileName = att.name;
        } else if (message.reference) {
            try {
                const refMsg = await message.channel.messages.fetch(message.reference.messageId);
                if (refMsg.attachments.size > 0) {
                    const att = refMsg.attachments.first();
                    fileUrl = att.url;
                    fileName = att.name;
                }
            } catch { /* ignore */ }
        }

        const args2 = message.content.split(' ');
        if (!fileUrl && args2.length > 1) fileUrl = args2[1];

        if (!fileUrl) {
            return message.reply(
                '**Usage:**\n' +
                '• Attach a file and run `.upload`\n' +
                '• Reply to a message with a file and run `.upload`\n' +
                '• Run `.upload <raw_url>`'
            );
        }

        const uploadMsg = await message.reply('Uploading to Pastefy...');

        try {
            // Download the file content
            const res = await fetch(fileUrl);
            if (!res.ok) return uploadMsg.edit('Failed to download the file.');
            const content = await res.text();

            // Detect language for syntax highlighting
            const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
            const langMap = { lua: 'LUA', js: 'JAVASCRIPT', ts: 'TYPESCRIPT', py: 'PYTHON', txt: 'PLAIN' };
            const language = langMap[ext] ?? 'PLAIN';

            // Upload to Pastefy v1 API
            const pastefyToken = process.env.PASTEFY_TOKEN || '1reB9Lyh1rmTtBydcXlCVW9W62Fhe6aBO4LE1il0biBH9fkjtBjsikXa2DIv';
            const pasteRes = await fetch('https://pastefy.app/api/v1/paste', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${pastefyToken}`,
                },
                body: JSON.stringify({
                    name: fileName,
                    content,
                    language,
                }),
            });

            if (!pasteRes.ok) {
                const errText = await pasteRes.text().catch(() => pasteRes.statusText);
                return uploadMsg.edit(`Pastefy upload failed: \`${pasteRes.status} ${errText.substring(0, 200)}\``);
            }

            const data = await pasteRes.json();
            const pasteUrl = data?.paste?.id
                ? `https://pastefy.app/${data.paste.id}`
                : data?.url ?? 'Unknown URL';

            await uploadMsg.edit(`Uploaded! ${pasteUrl}`);

        } catch (e) {
            console.error(e);
            await uploadMsg.edit(`Upload error: ${e.message}`);
        }
    }
});

// Login to Discord using the token from environment variables
const discordToken = process.env.DISCORD_TOKEN;
if (!discordToken) {
    console.error("ERROR: DISCORD_TOKEN is not defined in your environment variables or .env file!");
    process.exit(1);
}
client.login(discordToken);

// Start a simple HTTP health check server for Hugging Face Spaces (Port 7860)
const http = require('http');
const PORT = process.env.PORT || 7860;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Prometheus Deobfuscator Bot</title>
            <style>
                body {
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    background: #0f0c20;
                    color: #fff;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    height: 100vh;
                    margin: 0;
                }
                .card {
                    background: rgba(255, 255, 255, 0.05);
                    padding: 40px;
                    border-radius: 16px;
                    box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
                    backdrop-filter: blur(8px);
                    border: 1px solid rgba(255, 255, 255, 0.18);
                    text-align: center;
                }
                h1 { margin-bottom: 10px; color: #a855f7; }
                p { color: #cbd5e1; }
                .status {
                    display: inline-block;
                    padding: 8px 16px;
                    background: #22c55e;
                    color: #fff;
                    border-radius: 20px;
                    font-weight: bold;
                    margin-top: 20px;
                }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>Prometheus Deobfuscator Bot</h1>
                <p>Status dashboard for the advanced automated deobfuscator bot.</p>
                <div class="status">Bot is Active &amp; Running</div>
            </div>
        </body>
        </html>
    `);
}).listen(PORT, () => {
    console.log(`Health check server listening on port ${PORT}`);
});
