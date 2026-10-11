const { default: makeWASocket, useMultiFileAuthState, downloadMediaMessage, makeCacheableSignalKeyStore, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const axios = require('axios');
const express = require('express');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;
let qrCodeImage = "";
let pairingCodeDisplay = "Waiting for code generation...";

app.get('/', (req, res) => {
    if (qrCodeImage) {
        res.send(`
            <div style="text-align: center; margin-top: 15vh; font-family: sans-serif;">
                <h1>Scan WhatsApp QR Code:</h1>
                <img src="${qrCodeImage}" alt="QR Code" style="width: 300px; height: 300px; border: 2px solid #ccc; border-radius: 10px; padding: 10px;"/>
                <p>Refresh the page if code expires or is not visible.</p>
            </div>
        `);
    } else {
        res.send(`<h1 style="font-family: sans-serif; text-align: center; margin-top: 20vh;">WhatsApp Pairing Code:<br><span style="color: #007bff; font-size: 48px;">${pairingCodeDisplay}</span></h1><p style="text-align: center;">Refresh the page if code is not visible yet.</p>`);
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

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

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            try {
                qrCodeImage = await QRCode.toDataURL(qr);
                console.log('QR Code generated successfully!');
            } catch (err) {
                console.log('Error generating QR code image:', err);
            }
        }

        if(connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if(shouldReconnect) {
                connectToWhatsApp();
            }
        } else if(connection === 'open') {
            console.log('Bot Connected Successfully!');
            qrCodeImage = "";
            pairingCodeDisplay = "Connected Successfully! ✅";
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;
        const messageType = Object.keys(m.message)[0];
        const sender = m.key.remoteJid;

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

        if (text.startsWith('!dp ')) {
            const number = text.split(' ')[1].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
            try {
                const dpUrl = await sock.profilePictureUrl(number, 'image');
                await sock.sendMessage(sender, { image: { url: dpUrl }, caption: 'Here is the Profile Picture!' });
            } catch (e) {
                await sock.sendMessage(sender, { text: 'Could not fetch profile picture.' });
            }
        }

        if (text.startsWith('!tiktok ')) {
            const tikTokUrl = text.split(' ')[1];
            if (!tikTokUrl) {
                await sock.sendMessage(sender, { text: 'Please provide a valid TikTok link.' });
                return;
            }
            await sock.sendMessage(sender, { text: 'Downloading TikTok video, please wait...' });
            try {
                const res = await axios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(tikTokUrl)}`);
                if (res.data && res.data.code === 0 && res.data.data) {
                    const videoData = res.data.data;
                    await sock.sendMessage(sender, { 
                        video: { url: videoData.play }, 
                        caption: `*Title:* ${videoData.title || 'TikTok Video'}\n*Author:* ${videoData.author?.nickname || 'Unknown'}` 
                    });
                } else {
                    await sock.sendMessage(sender, { text: 'Failed to fetch TikTok video. Please try another link.' });
                }
            } catch (e) {
                console.log('TikTok error:', e.message);
                await sock.sendMessage(sender, { text: 'Error processing TikTok link.' });
            }
        }
    });
}

connectToWhatsApp();
