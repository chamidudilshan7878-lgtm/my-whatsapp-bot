const { default: makeWASocket, useMultiFileAuthState, downloadMediaMessage, makeCacheableSignalKeyStore, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const axios = require('axios');

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        printQRInTerminal: false
    });

    if (!sock.authState.creds.registered) {
        const phoneNumber = process.env.PHONE_NUMBER; 
        if (phoneNumber) {
            setTimeout(async () => {
                try {
                    let code = await sock.requestPairingCode(phoneNumber);
                    console.log(`\n========================================\nYOUR PAIRING CODE: ${code}\n========================================\n`);
                } catch (err) {
                    console.log('Error getting pairing code:', err);
                }
            }, 4000);
        }
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if(connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if(shouldReconnect) {
                connectToWhatsApp();
            }
        } else if(connection === 'open') {
            console.log('Bot Connected Successfully!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const messageType = Object.keys(m.message)[0];
        const sender = m.key.remoteJid;

        // View Once Media Handler
        if (messageType === 'viewOnceMessage' || messageType === 'viewOnceMessageV2') {
            try {
                const actualMessage = m.message[messageType].message;
                const mediaType = Object.keys(actualMessage)[0];
                const stream = await downloadMediaMessage(
                    { message: actualMessage, key: m.key },
                    'buffer',
                    {},
                    { logger: pino({ level: 'silent' }) }
                );
                
                if (mediaType === 'imageMessage') {
                    await sock.sendMessage(sender, { image: stream, caption: '💾 Saved View Once Image!' });
                } else if (mediaType === 'videoMessage') {
                    await sock.sendMessage(sender, { video: stream, caption: '💾 Saved View Once Video!' });
                }
            } catch (err) {
                console.log('Error downloading view once:', err);
            }
        }

        const text = m.message.conversation || m.message.extendedTextMessage?.text;
        if (!text) return;

        // DP Download Command: !dp 94771234567
        if (text.startsWith('!dp ')) {
            const number = text.split(' ')[1].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
            try {
                const dpUrl = await sock.profilePictureUrl(number, 'image');
                await sock.sendMessage(sender, { image: { url: dpUrl }, caption: 'Here is the Profile Picture!' });
            } catch (e) {
                await sock.sendMessage(sender, { text: 'Could not fetch profile picture (Privacy settings might be on).' });
            }
        }

        // TikTok Download Command: !tiktok <url>
        if (text.startsWith('!tiktok ')) {
            const tikTokUrl = text.split(' ')[1];
            if (!tikTokUrl) {
                app.sendMessage(sender, { text: 'Please provide a valid TikTok link.' });
                return;
            }

            await sock.sendMessage(sender, { text: 'Downloading TikTok video, please wait...' });
            try {
                const res = await axios.get(`https://tikwm.com/api/?url=${encodeURIComponent(tikTokUrl)}`);
                if (res.data && res.data.data) {
                    const videoData = res.data.data;
                    await sock.sendMessage(sender, { 
                        video: { url: videoData.play }, 
                        caption: `*Title:* ${videoData.title}\n*Author:* ${videoData.author.nickname}\n\nDownloaded via Bot` 
                    });
                } else {
                    await sock.sendMessage(sender, { text: 'Failed to download TikTok video.' });
                }
            } catch (e) {
                await sock.sendMessage(sender, { text: 'Error processing TikTok link.' });
            }
        }
    });
}

connectToWhatsApp();
