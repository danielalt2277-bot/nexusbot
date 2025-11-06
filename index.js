require('dotenv').config();
const { Client: BotClient, GatewayIntentBits, REST, Routes, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { Client: SelfBotClient } = require('discord.js-selfbot-v13');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const { v4: uuidv4 } = require('uuid');
const ms = require('ms');
const path = require('path');
const fs = require('fs');

const client = new BotClient({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });

const dbFile = path.join(__dirname, 'db.json');
const adapter = new JSONFile(dbFile);
const db = new Low(adapter, { keys: [], users: [] });

(async () => {
    await db.read();
    db.data = db.data || { keys: [], users: [] };
    await db.write();
})();

const activeBumps = {};
const activeVouches = {};
const activeTrades = {};
const activeChats = {};
const messageQueue = [];
let isProcessingQueue = false;
const clientPool = new Map();
const BASE_URL = 'https://discord.com/api/v9';

// --- SAFEGUARDS AND HELPERS ---

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function safeFetch(url, options) {
    let response = await fetch(url, options);
    while (response.status === 429) {
        const data = await response.json();
        const retryAfter = (data.retry_after * 1000) + 500; // Add 500ms buffer
        console.warn(`[Rate Limit] Waiting for ${retryAfter / 1000}s.`);
        await sleep(retryAfter);
        response = await fetch(url, options);
    }
    return response;
}

function getBumpInterval() {
    // Base interval: 2 hours 15 mins. Jitter: 1 to 6 minutes.
    const baseInterval = (2 * 60 * 60 * 1000) + (15 * 60 * 1000);
    const jitter = (Math.floor(Math.random() * 6) + 1) * 60 * 1000;
    return baseInterval + jitter;
}

const selfBotOptions = {
    checkUpdate: false,
    ws: {
        properties: {
            os: 'Windows',
            browser: 'Discord Client',
            release_channel: 'stable',
            device: '',
        }
    }
};

async function checkToken(token) {
    return new Promise((resolve) => {
        const checkerClient = new SelfBotClient(selfBotOptions);
        const loginTimeout = setTimeout(() => { checkerClient.destroy(); resolve(false); }, 10000);
        checkerClient.on('ready', () => { clearTimeout(loginTimeout); checkerClient.destroy(); resolve(true); });
        checkerClient.login(token).catch(() => { clearTimeout(loginTimeout); checkerClient.destroy(); resolve(false); });
    });
}

// --- BUMP FUNCTIONS ---

async function executeBump(userId, token, channelId) {
    if (!token) return;
    const selfBotClient = new SelfBotClient(selfBotOptions);

    selfBotClient.on('ready', async () => {
        try {
            const channel = await selfBotClient.channels.fetch(channelId);
            if (!channel) {
                console.error(`[AutoBump] Could not find channel ${channelId}.`);
                return;
            }
            await channel.sendSlash('302050872383242240', 'bump');
            console.log(`[AutoBump] Successfully sent bump command in #${channel.name}.`);
        } catch (error) {
            console.error(`[AutoBump] Failed to send bump command:`, error.message);
        } finally {
            selfBotClient.destroy();
        }
    });

    selfBotClient.login(token).catch(async (err) => {
        if (err.message.includes('Incorrect login details')) {
            console.error(`[AutoBump] Token for user ${userId} is invalid. Disabling service.`);
            const user = db.data.users.find(u => u.id === userId);
            if (user) {
                user.services.autoBump.isActive = false;
                user.services.autoBump.token = null; // Clear the invalid token
                await db.write();
                stopBumping(userId);
            }
        } else {
            console.error(`[AutoBump] Self-bot login failed:`, err.message);
        }
    });
}

function startBumping(userId, channelId, token) {
    if (activeBumps[userId]) clearTimeout(activeBumps[userId].timeout);

    const run = () => {
        const user = db.data.users.find(u => u.id === userId);
        if (!user?.services?.autoBump?.isActive) return;

        executeBump(userId, token, channelId);
        const nextInterval = getBumpInterval();
        console.log(`[AutoBump] Next bump for user ${userId} in ${(nextInterval / (1000 * 60)).toFixed(2)} minutes.`);
        activeBumps[userId] = { timeout: setTimeout(run, nextInterval) };
    };
    run();
}

function stopBumping(userId) {
    if (activeBumps[userId]) {
        clearTimeout(activeBumps[userId].timeout);
        delete activeBumps[userId];
    }
}

// --- VOUCH FUNCTIONS ---

async function processMessageQueue() {
    if (isProcessingQueue || messageQueue.length === 0) return;
    isProcessingQueue = true;

    const { client: selfBot, channelId, body, serviceName } = messageQueue.shift();

    try {
        const channel = await selfBot.channels.fetch(channelId);
        if (!channel) {
            console.error(`[${serviceName}] Could not find channel ${channelId}.`);
            return;
        }

        await channel.sendTyping();
        await sleep(Math.floor(Math.random() * 2000) + 1000); // 1-3s typing

        await channel.send(body.content);
        console.log(`[${serviceName}] Successfully sent message to channel ${channelId} by ${selfBot.user.tag}.`);

    } catch (error) {
        console.error(`[${serviceName}] Error sending message:`, error);
    } finally {
        const delay = Math.floor(Math.random() * 4000) + 2000; // 2-6s delay
        await sleep(delay);
        isProcessingQueue = false;
        processMessageQueue();
    }
}

function addToMessageQueue(token, channelId, body, serviceName) {
    const client = clientPool.get(token);
    if (!client) {
        console.error(`[${serviceName}] Could not find a logged-in client for the selected token.`);
        return;
    }
    messageQueue.push({ client, channelId, body, serviceName });
    if (!isProcessingQueue) {
        processMessageQueue();
    }
}

function startVouching(userId, channelId, targetUserId) {
    if (activeVouches[userId]) clearTimeout(activeVouches[userId].timeout);

    const run = async () => {
        const user = db.data.users.find(u => u.id === userId);
        if (!user?.services?.autoVouch?.isActive) return;

        try {
            const vouches = fs.readFileSync('vouches.txt', 'utf-8').split('\n').map(v => v.trim()).filter(Boolean);
            const tokens = JSON.parse(fs.readFileSync('tokens.json', 'utf-8'));
            const userVouches = vouches; // No pre-filtering

            if (!userVouches.length || !tokens.length) {
                console.error("[AutoVouch] No vouches found in vouches.txt or no tokens available. Stopping service.");
                return;
            }

            const vouch = userVouches[Math.floor(Math.random() * userVouches.length)];
            const token = tokens[Math.floor(Math.random() * tokens.length)];

            const targetUserIds = targetUserId.split(',').map(id => id.trim());
            const currentTargetId = targetUserIds[Math.floor(Math.random() * targetUserIds.length)];
            await db.write();

            const finalVouch = vouch.replace(/<@useid>/g, `<@${currentTargetId}>`);
            addToMessageQueue(token, channelId, { content: finalVouch }, 'AutoVouch');

            const delay = Math.floor(Math.random() * (600000 - 180000 + 1)) + 180000; // 3-10 mins
            console.log(`[AutoVouch] Next vouch for user ${userId} in ${(delay / 60000).toFixed(2)} minutes.`);
            activeVouches[userId] = { timeout: setTimeout(run, delay) };
        } catch (error) {
            console.error("[AutoVouch] A critical error occurred in the vouching loop:", error);
        }
    };
    run();
}

function stopVouching(userId) {
    if (activeVouches[userId]) {
        clearTimeout(activeVouches[userId].timeout);
        delete activeVouches[userId];
    }
}

// --- TRADE FUNCTIONS ---

function startTrading(userId, channelId) {
    if (activeTrades[userId]) clearTimeout(activeTrades[userId].timeout);

    const run = async () => {
        const user = db.data.users.find(u => u.id === userId);
        if (!user?.services?.autotrade?.isActive) return;

        try {
            const messages = fs.readFileSync('tradingmessages.txt', 'utf-8').split('\n').map(v => v.trim()).filter(Boolean);
            const tokens = JSON.parse(fs.readFileSync('tokens.json', 'utf-8'));

            if (!messages.length || !tokens.length) {
                console.error("[AutoTrade] No messages found in tradingmessages.txt or no tokens available. Stopping service.");
                return;
            }

            user.services.autotrade.lastMessages = user.services.autotrade.lastMessages || [];
            let message;
            do {
                message = messages[Math.floor(Math.random() * messages.length)];
            } while (user.services.autotrade.lastMessages.includes(message) && messages.length > 3);
            user.services.autotrade.lastMessages.push(message);
            if (user.services.autotrade.lastMessages.length > 3) user.services.autotrade.lastMessages.shift();

            user.services.autotrade.lastTokens = user.services.autotrade.lastTokens || [];
            let token;
            do {
                token = tokens[Math.floor(Math.random() * tokens.length)];
            } while (user.services.autotrade.lastTokens.includes(token) && tokens.length > 3);
            user.services.autotrade.lastTokens.push(token);
            if (user.services.autotrade.lastTokens.length > 3) user.services.autotrade.lastTokens.shift();

            const channelIds = channelId.split(',').map(id => id.trim());
            const nextIndex = user.services.autotrade.nextChannelIndex || 0;
            const currentChannelId = channelIds[nextIndex];
            user.services.autotrade.nextChannelIndex = (nextIndex + 1) % channelIds.length;
            await db.write();

            addToMessageQueue(token, currentChannelId, { content: message }, 'AutoTrade');

            const delay = Math.floor(Math.random() * (600000 - 180000 + 1)) + 180000; // 3-10 mins
            console.log(`[AutoTrade] Next trade message for user ${userId} in ${(delay / 60000).toFixed(2)} minutes.`);
            activeTrades[userId] = { timeout: setTimeout(run, delay) };
        } catch (error) {
            console.error("[AutoTrade] A critical error occurred in the trading loop:", error);
        }
    };
    run();
}

function stopTrading(userId) {
    if (activeTrades[userId]) {
        clearTimeout(activeTrades[userId].timeout);
        delete activeTrades[userId];
    }
}

// --- CHAT FUNCTIONS ---

function startChatting(userId, channelId) {
    if (activeChats[userId]) clearTimeout(activeChats[userId].timeout);

    const run = async () => {
        const user = db.data.users.find(u => u.id === userId);
        if (!user?.services?.autochat?.isActive) return;

        try {
            const messages = fs.readFileSync('chat.txt', 'utf-8').split('\n').map(v => v.trim()).filter(Boolean);
            const tokens = JSON.parse(fs.readFileSync('tokens.json', 'utf-8'));

            if (!messages.length || !tokens.length) {
                console.error("[AutoChat] No messages found in chat.txt or no tokens available. Stopping service.");
                return;
            }

            const message = messages[Math.floor(Math.random() * messages.length)];
            const token = tokens[Math.floor(Math.random() * tokens.length)];
            await db.write();

            addToMessageQueue(token, channelId, { content: message }, 'AutoChat');

            const delay = Math.floor(Math.random() * (180000 - 60000 + 1)) + 60000; // 1-3 mins
            console.log(`[AutoChat] Next chat message for user ${userId} in ${(delay / 60000).toFixed(2)} minutes.`);
            activeChats[userId] = { timeout: setTimeout(run, delay) };
        } catch (error) {
            console.error("[AutoChat] A critical error occurred in the chatting loop:", error);
        }
    };
    run();
}

function stopChatting(userId) {
    if (activeChats[userId]) {
        clearTimeout(activeChats[userId].timeout);
        delete activeChats[userId];
    }
}

// --- CLIENT POOL FUNCTIONS ---

async function initializeClientPool() {
    console.log('[Client Pool] Initializing...');
    let tokens = [];
    try {
        tokens = JSON.parse(fs.readFileSync('tokens.json', 'utf-8'));
    } catch (error) {
        console.error('[Client Pool] Could not read or parse tokens.json:', error.message);
        return;
    }

    for (const token of tokens) {
        const client = new SelfBotClient(selfBotOptions);
        try {
            await new Promise((resolve, reject) => {
                client.on('ready', () => {
                    console.log(`[Client Pool] Logged in as ${client.user.tag}.`);
                    clientPool.set(token, client);
                    resolve();
                });
                client.login(token).catch(reject);
            });
        } catch (error) {
            console.error(`[Client Pool] Failed to login token ending in ...${token.slice(-5)}:`, error.message);
        }
    }
    console.log(`[Client Pool] Initialization complete. ${clientPool.size}/${tokens.length} clients logged in.`);
}


// --- COMMANDS AND INTERACTIONS ---

const commands = [
    { name: 'auto-bump', description: 'Starts the auto-bumping process.', options: [{ name: 'key', type: 3, description: 'Your license key.', required: true }, { name: 'channel_id', type: 3, description: 'The channel ID for bumping.', required: true }, { name: 'token', type: 3, description: 'Your authorization token.', required: true }] },
    { name: 'autovouch', description: 'Starts the auto-vouching process.', options: [{ name: 'key', type: 3, description: 'Your license key.', required: true }, { name: 'channel_id', type: 3, description: 'The channel ID for vouching.', required: true }, { name: 'user_id', type: 3, description: 'The user ID(s) to vouch for, separated by commas.', required: true }] },
    { name: 'autotrade', description: 'Starts the auto-trading process.', options: [{ name: 'key', type: 3, description: 'Your license key.', required: true }, { name: 'channel_id', type: 3, description: 'The channel ID(s) for trading messages, separated by commas.', required: true }] },
    { name: 'autochat', description: 'Starts the auto-chatting process.', options: [{ name: 'key', type: 3, description: 'Your license key.', required: true }, { name: 'channel_id', type: 3, description: 'The channel ID for chatting messages.', required: true }] },
    {
        name: 'key-gen',
        description: 'Generates a new key for a specific service.',
        options: [
            { name: 'user', type: 6, description: 'The user to generate the key for.', required: true },
            { name: 'duration', type: 3, description: 'Duration (e.g., 7d, 1m, 0 for perm).', required: true },
            {
                name: 'service',
                type: 3,
                description: 'The service this key will unlock.',
                required: true,
                choices: [
                    { name: 'Auto-Bump', value: 'autobump' },
                    { name: 'Auto-Vouch', value: 'autovouch' },
                    { name: 'Auto-Trade', value: 'autotrade' },
                    { name: 'Auto-Chat', value: 'autochat' }
                ]
            }
        ]
    },
    { name: 'check-keys', description: 'Checks the status of keys.', options: [{ name: 'user', type: 6, description: 'The user to search for.', required: false }] },
    { name: 'manage', description: 'Manage your active services.' },
    { name: 'tokencheck', description: 'Checks and manages all stored tokens.', options: [{ name: 'action', type: 3, description: 'Optional action for invalid tokens.', required: false, choices: [{ name: 'Remove Invalid Tokens', value: 'remove' }] }] }
];

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
(async () => {
    try {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('Successfully reloaded application commands.');
    } catch (error) { console.error(error); }
})();

client.on('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    await initializeClientPool();
    db.data.users.forEach(user => {
        if (user.services?.autoBump?.isActive) startBumping(user.id, user.services.autoBump.channelId, user.services.autoBump.token);
        if (user.services?.autoVouch?.isActive) startVouching(user.id, user.services.autoVouch.channelId, user.services.autoVouch.userId);
        if (user.services?.autotrade?.isActive) startTrading(user.id, user.services.autotrade.channelId);
        if (user.services?.autochat?.isActive) startChatting(user.id, user.services.autochat.channelId);
    });
    console.log(`Restarted active services.`);
});

client.on('interactionCreate', async interaction => {
    const userId = interaction.user.id;
    const findUser = () => db.data.users.find(u => u.id === userId);
    const createUser = () => {
        const newUser = { id: userId, services: {} };
        db.data.users.push(newUser);
        return newUser;
    };

    if (interaction.isCommand()) {
        const { commandName } = interaction;
        if (['auto-bump', 'autovouch', 'autotrade', 'autochat'].includes(commandName)) {
            const key = interaction.options.getString('key');
            const keyData = db.data.keys.find(k => k.key === key);
            const serviceName = commandName.replace('-', '');

            if (!keyData || keyData.isUsed || (keyData.expiresAt && new Date(keyData.expiresAt) < new Date()) || keyData.service !== serviceName) {
                return interaction.reply({ content: `This key is invalid, already used, expired, or not for the \`${serviceName}\` service.`, flags: 64 });
            }
            keyData.isUsed = true;
            keyData.usedBy = userId;
            keyData.usedAt = new Date();
        }

        if (commandName === 'auto-bump') {
            const user = findUser() || createUser();
            user.services.autoBump = { channelId: interaction.options.getString('channel_id'), token: interaction.options.getString('token'), isActive: true };
            await db.write();
            startBumping(userId, user.services.autoBump.channelId, user.services.autoBump.token);
            await interaction.reply({ content: `Auto-bumping has started.`, flags: 64 });
        } else if (commandName === 'autovouch') {
            const user = findUser() || createUser();
            user.services.autoVouch = {
                channelId: interaction.options.getString('channel_id'),
                userId: interaction.options.getString('user_id'),
                isActive: true,
                lastVouch: null,
                lastToken: null
            };
            await db.write();
            startVouching(userId, user.services.autoVouch.channelId, user.services.autoVouch.userId);
            await interaction.reply({ content: `Auto-vouching has started.`, flags: 64 });
        } else if (commandName === 'autotrade') {
            const user = findUser() || createUser();
            user.services.autotrade = {
                channelId: interaction.options.getString('channel_id'),
                isActive: true,
                lastMessage: null,
                lastToken: null,
                nextChannelIndex: 0
            };
            await db.write();
            startTrading(userId, user.services.autotrade.channelId);
            await interaction.reply({ content: `Auto-trading has started.`, flags: 64 });
        } else if (commandName === 'autochat') {
            const user = findUser() || createUser();
            user.services.autochat = { channelId: interaction.options.getString('channel_id'), isActive: true, lastMessage: null, lastToken: null };
            await db.write();
            startChatting(userId, user.services.autochat.channelId);
            await interaction.reply({ content: `Auto-chatting has started.`, flags: 64 });
        } else if (commandName === 'key-gen') {
            if (userId !== '1159088261973692446') return interaction.reply({ content: 'Unauthorized.', flags: 64 });

            const targetUser = interaction.options.getUser('user');
            const durationStr = interaction.options.getString('duration');
            const service = interaction.options.getString('service');
            const duration = durationStr === '0' ? Infinity : ms(durationStr);

            if (isNaN(duration)) return interaction.reply({ content: 'Invalid duration format.', flags: 64 });

            const expiresAt = duration === Infinity ? null : new Date(Date.now() + duration);
            const newKey = uuidv4();

            db.data.keys.push({ key: newKey, service: service, generatedBy: userId, generatedAt: new Date(), expiresAt, isUsed: false, usedBy: null, usedAt: null });
            await db.write();

            const embed = new EmbedBuilder()
                .setTitle('Your New License Key')
                .setColor('#00FF00')
                .addFields(
                    { name: 'Service', value: `\`${service}\`` },
                    { name: 'Key', value: `\`${newKey}\`` },
                    { name: 'Expires', value: expiresAt ? `<t:${Math.floor(expiresAt.getTime() / 1000)}:R>` : 'Never' }
                );

            try {
                await targetUser.send({ embeds: [embed] });
                await interaction.reply({ content: `Successfully generated and sent a ${service} key to ${targetUser.tag}.`, flags: 64 });
            } catch (error) {
                console.error(`Could not send DM to ${targetUser.tag}.`);
                await interaction.reply({ content: `Could not DM ${targetUser.tag}. The key is: \`${newKey}\``, flags: 64 });
            }
        } else if (commandName === 'check-keys') {
            if (userId !== '1159088261973692446') return interaction.reply({ content: 'Unauthorized.', flags: 64 });
            const targetUser = interaction.options.getUser('user');
            if (targetUser) {
                const userKey = db.data.keys.find(k => k.usedBy === targetUser.id);
                if (!userKey) return interaction.reply({ content: `${targetUser.tag} has no key.`, flags: 64 });
                const embed = new EmbedBuilder().setTitle(`Key Info for ${targetUser.username}`).addFields({ name: 'Key', value: `\`${userKey.key}\`` }, { name: 'Status', value: userKey.isUsed ? 'Used' : 'Not Used' }, { name: 'Expires', value: userKey.expiresAt ? `<t:${Math.floor(new Date(userKey.expiresAt).getTime() / 1000)}:R>` : 'Never' });
                const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`delete_key_${userKey.key}`).setLabel('Delete').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`edit_key_${userKey.key}`).setLabel('Edit Expiry').setStyle(ButtonStyle.Primary));
                await interaction.reply({ embeds: [embed], components: [row], flags: 64 });
            } else {
                const page = 0;
                const keysPerPage = 5;
                const allKeys = db.data.keys;
                const totalPages = Math.ceil(allKeys.length / keysPerPage) || 1;
                const generateEmbed = (currentPage) => {
                    const keysOnPage = allKeys.slice(currentPage * keysPerPage, (currentPage + 1) * keysPerPage);
                    return new EmbedBuilder().setTitle('All Generated Keys').setDescription(keysOnPage.map(k => `**Key:** \`${k.key}\`\n**Used by:** ${k.usedBy ? `<@${k.usedBy}>` : 'N/A'}\n**Expires:** ${k.expiresAt ? `<t:${Math.floor(new Date(k.expiresAt).getTime() / 1000)}:R>` : 'Never'}`).join('\n\n') || 'No keys.').setFooter({ text: `Page ${currentPage + 1} of ${totalPages}` });
                };
                const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ck_prev').setLabel('Previous').setStyle(ButtonStyle.Primary).setDisabled(page === 0), new ButtonBuilder().setCustomId('ck_next').setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(page >= totalPages - 1));
                await interaction.reply({ embeds: [generateEmbed(page)], components: [row], flags: 64 });
            }
        } else if (commandName === 'manage') {
            const user = findUser();
            if (!user || !Object.keys(user.services).length) return interaction.reply({ content: 'You have no services.', flags: 64 });
            const embed = new EmbedBuilder().setTitle('Service Management');
            const rows = [];
            if (user.services.autoBump) {
                const s = user.services.autoBump;
                embed.addFields({ name: 'Auto-Bump', value: `Status: **${s.isActive ? 'Active' : 'Inactive'}**\nChannel: <#${s.channelId}>` });
                rows.push(new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('manage_bump_start').setLabel('Start').setStyle(ButtonStyle.Success).setDisabled(s.isActive),
                    new ButtonBuilder().setCustomId('manage_bump_stop').setLabel('Stop').setStyle(ButtonStyle.Danger).setDisabled(!s.isActive),
                    new ButtonBuilder().setCustomId('edit_bump').setLabel('Edit').setStyle(ButtonStyle.Primary)
                ));
            }
            if (user.services.autoVouch) {
                const s = user.services.autoVouch;
                const userIds = s.userId.split(',').map(id => `<@${id.trim()}>`).join(', ');
                embed.addFields({ name: 'Auto-Vouch', value: `Status: **${s.isActive ? 'Active' : 'Inactive'}**\nChannel: <#${s.channelId}>\nUsers: ${userIds}` });
                rows.push(new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('manage_vouch_start').setLabel('Start').setStyle(ButtonStyle.Success).setDisabled(s.isActive),
                    new ButtonBuilder().setCustomId('manage_vouch_stop').setLabel('Stop').setStyle(ButtonStyle.Danger).setDisabled(!s.isActive),
                    new ButtonBuilder().setCustomId('edit_vouch').setLabel('Edit').setStyle(ButtonStyle.Primary)
                ));
            }
            if (user.services.autotrade) {
                const s = user.services.autotrade;
                const channelIds = s.channelId.split(',').map(id => `<#${id.trim()}>`).join(', ');
                embed.addFields({ name: 'Auto-Trade', value: `Status: **${s.isActive ? 'Active' : 'Inactive'}**\nChannels: ${channelIds}` });
                rows.push(new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('manage_trade_start').setLabel('Start').setStyle(ButtonStyle.Success).setDisabled(s.isActive),
                    new ButtonBuilder().setCustomId('manage_trade_stop').setLabel('Stop').setStyle(ButtonStyle.Danger).setDisabled(!s.isActive),
                    new ButtonBuilder().setCustomId('edit_trade').setLabel('Edit').setStyle(ButtonStyle.Primary)
                ));
            }
            if (user.services.autochat) {
                const s = user.services.autochat;
                embed.addFields({ name: 'Auto-Chat', value: `Status: **${s.isActive ? 'Active' : 'Inactive'}**\nChannel: <#${s.channelId}>` });
                rows.push(new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('manage_chat_start').setLabel('Start').setStyle(ButtonStyle.Success).setDisabled(s.isActive),
                    new ButtonBuilder().setCustomId('manage_chat_stop').setLabel('Stop').setStyle(ButtonStyle.Danger).setDisabled(!s.isActive),
                    new ButtonBuilder().setCustomId('edit_chat').setLabel('Edit').setStyle(ButtonStyle.Primary)
                ));
            }
            await interaction.reply({ embeds: [embed], components: rows, flags: 64 });
        } else if (commandName === 'tokencheck') {
             if (userId !== '1159088261973692446') return interaction.reply({ content: 'Unauthorized.', flags: 64 });
            await interaction.deferReply({ flags: 64 });
            const dbTokens = db.data.users.filter(u => u.services?.autoBump?.token).map(u => u.services.autoBump.token);
            let rawFileTokens = [];
            try { rawFileTokens = JSON.parse(fs.readFileSync('tokens.json', 'utf-8')); } catch { }
            const uniqueTokens = [...new Set([...dbTokens, ...rawFileTokens])];
            if (!uniqueTokens.length) return interaction.editReply('No tokens found.');

            const valid = [], invalid = [];
            for (const token of uniqueTokens) { (await checkToken(token) ? valid : invalid).push(token); }

            const embed = new EmbedBuilder().setTitle('Token Check Report').setColor(invalid.length ? '#FF0000' : '#00FF00').addFields({ name: '✅ Valid', value: `${valid.length}`, inline: true }, { name: '❌ Invalid', value: `${invalid.length}`, inline: true });
            if (interaction.options.getString('action') === 'remove' && invalid.length) {
                const newFileTokens = rawFileTokens.filter(t => !invalid.includes(t));
                fs.writeFileSync('tokens.json', JSON.stringify(newFileTokens, null, 2));
                let disabledCount = 0;
                db.data.users.forEach(u => {
                    if (u.services?.autoBump?.token && invalid.includes(u.services.autoBump.token)) {
                        stopBumping(u.id);
                        u.services.autoBump.isActive = false;
                        u.services.autoBump.token = null;
                        disabledCount++;
                    }
                });
                if (disabledCount) await db.write();
                embed.setDescription(`Removed **${rawFileTokens.length - newFileTokens.length}** from \`tokens.json\`.\nDisabled **${disabledCount}** bump services.`);
            } else if (invalid.length) {
                embed.addFields({ name: 'Full Invalid Tokens', value: `\`\`\`${invalid.join('\n').substring(0, 1000)}\`\`\`` });
            }
            await interaction.editReply({ embeds: [embed] });
        }
    } else if (interaction.isButton()) {
        const [action, ...args] = interaction.customId.split('_');

        if (action === 'manage') {
            const user = findUser();
            if (!user) return;

            let serviceName;
            if (args[0] === 'bump') serviceName = 'autoBump';
            else if (args[0] === 'vouch') serviceName = 'autoVouch';
            else if (args[0] === 'trade') serviceName = 'autotrade';
            else if (args[0] === 'chat') serviceName = 'autochat';

            const operation = args[1];
            const s = user.services[serviceName];
            s.isActive = operation === 'start';

            if (s.isActive) {
                if (serviceName === 'autoBump') startBumping(userId, s.channelId, s.token);
                else if (serviceName === 'autoVouch') startVouching(userId, s.channelId, s.userId);
                else if (serviceName === 'autotrade') startTrading(userId, s.channelId);
                else if (serviceName === 'autochat') startChatting(userId, s.channelId);
            } else {
                if (serviceName === 'autoBump') stopBumping(userId);
                else if (serviceName === 'autoVouch') stopVouching(userId);
                else if (serviceName === 'autotrade') stopTrading(userId);
                else if (serviceName === 'autochat') stopChatting(userId);
            }
            await db.write();

            const manageEmbed = new EmbedBuilder().setTitle('Service Management');
            const rows = [];
            if (user.services.autoBump) {
                const s = user.services.autoBump;
                manageEmbed.addFields({ name: 'Auto-Bump', value: `Status: **${s.isActive ? 'Active' : 'Inactive'}**\nChannel: <#${s.channelId}>` });
                rows.push(new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('manage_bump_start').setLabel('Start').setStyle(ButtonStyle.Success).setDisabled(s.isActive),
                    new ButtonBuilder().setCustomId('manage_bump_stop').setLabel('Stop').setStyle(ButtonStyle.Danger).setDisabled(!s.isActive),
                    new ButtonBuilder().setCustomId('edit_bump').setLabel('Edit').setStyle(ButtonStyle.Primary)
                ));
            }
            if (user.services.autoVouch) {
                const s = user.services.autoVouch;
                const userIds = s.userId.split(',').map(id => `<@${id.trim()}>`).join(', ');
                embed.addFields({ name: 'Auto-Vouch', value: `Status: **${s.isActive ? 'Active' : 'Inactive'}**\nChannel: <#${s.channelId}>\nUsers: ${userIds}` });
                rows.push(new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('manage_vouch_start').setLabel('Start').setStyle(ButtonStyle.Success).setDisabled(s.isActive),
                    new ButtonBuilder().setCustomId('manage_vouch_stop').setLabel('Stop').setStyle(ButtonStyle.Danger).setDisabled(!s.isActive),
                    new ButtonBuilder().setCustomId('edit_vouch').setLabel('Edit').setStyle(ButtonStyle.Primary)
                ));
            }
            if (user.services.autotrade) {
                const s = user.services.autotrade;
                manageEmbed.addFields({ name: 'Auto-Trade', value: `Status: **${s.isActive ? 'Active' : 'Inactive'}**\nChannel: <#${s.channelId}>` });
                rows.push(new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('manage_trade_start').setLabel('Start').setStyle(ButtonStyle.Success).setDisabled(s.isActive),
                    new ButtonBuilder().setCustomId('manage_trade_stop').setLabel('Stop').setStyle(ButtonStyle.Danger).setDisabled(!s.isActive),
                    new ButtonBuilder().setCustomId('edit_trade').setLabel('Edit').setStyle(ButtonStyle.Primary)
                ));
            }
            if (user.services.autochat) {
                const s = user.services.autochat;
                manageEmbed.addFields({ name: 'Auto-Chat', value: `Status: **${s.isActive ? 'Active' : 'Inactive'}**\nChannel: <#${s.channelId}>` });
                rows.push(new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('manage_chat_start').setLabel('Start').setStyle(ButtonStyle.Success).setDisabled(s.isActive),
                    new ButtonBuilder().setCustomId('manage_chat_stop').setLabel('Stop').setStyle(ButtonStyle.Danger).setDisabled(!s.isActive),
                    new ButtonBuilder().setCustomId('edit_chat').setLabel('Edit').setStyle(ButtonStyle.Primary)
                ));
            }
            await interaction.update({ embeds: [manageEmbed], components: rows });
        } else if (action === 'edit') {
            const service = args[0]; // 'bump', 'vouch', or 'trade'
            const user = findUser();
            const serviceData = user.services[service === 'bump' ? 'autoBump' : service === 'vouch' ? 'autoVouch' : service === 'trade' ? 'autotrade' : 'autochat'];

            const modal = new ModalBuilder()
                .setCustomId(`edit_modal_${service}`)
                .setTitle(`Edit ${service.charAt(0).toUpperCase() + service.slice(1)} Service`);

            if (service === 'bump') {
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('channel_id').setLabel('Channel ID').setStyle(TextInputStyle.Short).setValue(serviceData.channelId).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('token').setLabel('Token').setStyle(TextInputStyle.Short).setValue(serviceData.token).setRequired(true))
                );
            } else if (service === 'vouch') {
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('channel_id').setLabel('Channel ID').setStyle(TextInputStyle.Short).setValue(serviceData.channelId).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('user_id').setLabel('Target User ID').setStyle(TextInputStyle.Short).setValue(serviceData.userId).setRequired(true))
                );
            } else if (service === 'trade') {
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('channel_id').setLabel('Channel ID').setStyle(TextInputStyle.Short).setValue(serviceData.channelId).setRequired(true))
                );
            } else if (service === 'chat') {
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('channel_id').setLabel('Channel ID').setStyle(TextInputStyle.Short).setValue(serviceData.channelId).setRequired(true))
                );
            }
            await interaction.showModal(modal);
        } else if (action === 'delete' && args[0] === 'key') {
            db.data.keys = db.data.keys.filter(k => k.key !== args[1]);
            await db.write();
            await interaction.update({ content: `Key deleted.`, embeds: [], components: [] });
        } else if (action === 'edit' && args[0] === 'key') {
            const modal = new ModalBuilder().setCustomId(`edit_key_modal_${args[1]}`).setTitle('Edit Key Expiration').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('new_duration').setLabel('New duration (e.g., 30d, 0 for perm)').setStyle(TextInputStyle.Short).setRequired(true)));
            await interaction.showModal(modal);
        } else if (action === 'ck') {
            const embed = interaction.message.embeds[0];
            const footer = embed.footer.text;
            let currentPage = parseInt(footer.match(/(\d+)/g)[0], 10) - 1;
            currentPage += args[0] === 'next' ? 1 : -1;

            const keysPerPage = 5;
            const allKeys = db.data.keys;
            const totalPages = Math.ceil(allKeys.length / keysPerPage) || 1;
_
            const keysOnPage = allKeys.slice(currentPage * keysPerPage, (currentPage + 1) * keysPerPage);

            const newEmbed = new EmbedBuilder().setTitle('All Generated Keys').setDescription(keysOnPage.map(k => `**Key:** \`${k.key}\`\n**Used by:** ${k.usedBy ? `<@${k.usedBy}>` : 'N/A'}\n**Expires:** ${k.expiresAt ? `<t:${Math.floor(new Date(k.expiresAt).getTime() / 1000)}:R>` : 'Never'}`).join('\n\n') || 'No keys.').setFooter({ text: `Page ${currentPage + 1} of ${totalPages}` });
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ck_prev').setLabel('Previous').setStyle(ButtonStyle.Primary).setDisabled(currentPage === 0), new ButtonBuilder().setCustomId('ck_next').setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(currentPage >= totalPages - 1));
            await interaction.update({ embeds: [newEmbed], components: [row] });
        }
    } else if (interaction.isModalSubmit()) {
        const [action, ...args] = interaction.customId.split('_');
        if (action === 'edit' && args[0] === 'key' && args[1] === 'modal') {
            const keyData = db.data.keys.find(k => k.key === args[2]);
            const durationStr = interaction.fields.getTextInputValue('new_duration');
            const duration = durationStr === '0' ? Infinity : ms(durationStr);
            if (isNaN(duration)) return interaction.reply({ content: 'Invalid duration.', flags: 64 });
            keyData.expiresAt = duration === Infinity ? null : new Date(Date.now() + duration);
            await db.write();
            await interaction.reply({ content: `Key expiration updated.`, flags: 64 });
        } else if (action === 'edit' && args[0] === 'modal') {
            const service = args[1]; // 'bump', 'vouch', or 'trade'
            const user = findUser();
            const serviceName = service === 'bump' ? 'autoBump' : service === 'vouch' ? 'autoVouch' : service === 'trade' ? 'autotrade' : 'autochat';
            const serviceData = user.services[serviceName];

            const channelId = interaction.fields.getTextInputValue('channel_id');
            serviceData.channelId = channelId;

            if (service === 'bump') {
                const token = interaction.fields.getTextInputValue('token');
                serviceData.token = token;
                if (serviceData.isActive) {
                    stopBumping(userId);
                    startBumping(userId, channelId, token);
                }
            } else if (service === 'vouch') {
                const targetUserId = interaction.fields.getTextInputValue('user_id');
                serviceData.userId = targetUserId;
                serviceData.nextUserIdIndex = 0;
                if (serviceData.isActive) {
                    stopVouching(userId);
                    startVouching(userId, channelId, targetUserId);
                }
            } else if (service === 'trade') {
                serviceData.nextChannelIndex = 0;
                if (serviceData.isActive) {
                    stopTrading(userId);
                    startTrading(userId, channelId);
                }
            } else if (service === 'chat') {
                if (serviceData.isActive) {
                    stopChatting(userId);
                    startChatting(userId, channelId);
                }
            }

            await db.write();
            await interaction.reply({ content: `Successfully updated the ${service} service.`, flags: 64 });
        }
    }
});

client.login(process.env.BOT_TOKEN);