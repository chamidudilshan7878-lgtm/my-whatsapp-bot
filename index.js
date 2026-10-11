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
        const sender = m.key.remoteJid;

        // සියලුම ආකාරයේ මැසේජ් කන්ටේනර් වලින් text එක ලබා ගැනීම
        const msgBody = m.message?.conversation || 
                        m.message?.extendedTextMessage?.text || 
                        m.message?.ephemeralMessage?.message?.conversation || 
                        m.message?.ephemeralMessage?.message?.extendedTextMessage?.text || '';

        if (!msgBody) return;

        // බොට් පරීක්ෂා කිරීමේ ping විධානය
        if (msgBody.toLowerCase() === '!ping') {
            await sock.sendMessage(sender, { text: 'Bot is active and running! 🚀' });
            return;
        }

        // TikTok ඩවුන්ලෝඩ් විධානය (HD සහ Normal)
        if (msgBody.startsWith('!tiktok ')) {
            const args = msgBody.split(' ');
            const tikTokUrl = args[1];
            const quality = args[2] ? args[2].toLowerCase() : 'normal';

            if (!tikTokUrl) {
                await sock.sendMessage(sender, { text: 'කරුණාකර TikTok ලින්ක් එකක් ලබා දෙන්න. (උදා: !tiktok https://vt.tiktok.com/... hd)' });
                return;
            }

            await sock.sendMessage(sender, { text: 'TikTok වීඩියෝව සකස් කරමින් පවතී, කරුණාකර රැඳී සිටින්න...' });
            
            try {
                const res = await axios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(tikTokUrl)}`);
                if (res.data && res.data.code === 0 && res.data.data) {
                    const videoData = res.data.data;
                    let videoToDownload = videoData.play;
                    if (quality === 'hd' && videoData.hdplay) {
                        videoToDownload = videoData.hdplay;
                    }

                    await sock.sendMessage(sender, { 
                        video: { url: videoToDownload }, 
                        caption: `*Title:* ${videoData.title || 'TikTok Video'}\n*Author:* ${videoData.author?.nickname || 'Unknown'}\n*Quality:* ${quality.toUpperCase()}` 
                    });
                } else {
                    await sock.sendMessage(sender, { text: 'TikTok වීඩියෝව ලබා ගැනීමට නොහැකි විය. වෙනත් ලින්ක් එකක් උත්සාහ කරන්න.' });
                }
            } catch (e) {
                console.log('TikTok error:', e.message);
                await sock.sendMessage(sender, { text: 'TikTok ලින්ක් එක ප්‍රොසෙස් කිරීමේදී දෝෂයක් ඇති විය.' });
            }
        }
    });
}

connectToWhatsApp();
