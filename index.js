const fs = require('fs');

if (!fs.existsSync('.env')) {
    fs.writeFileSync('.env', 'BOT_TOKEN=YOUR_BOT_TOKEN_HERE');
    console.log('The .env file was not found, so a new one was created.');
    console.log('Please open the .env file and replace "YOUR_BOT_TOKEN_HERE" with your actual Discord bot token.');
    process.exit(0);
}

require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder } = require('discord.js');

if (!process.env.BOT_TOKEN || process.env.BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
    console.log('Bot token is not configured. Please open the .env file and add your bot token.');
    process.exit(0);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const bumpIntervals = new Map();

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);

    const autoBumpCommand = new SlashCommandBuilder()
        .setName('auto-bump')
        .setDescription('Sets up automatic bumping for a channel.')
        .addStringOption(option =>
            option.setName('channelid')
                .setDescription('The ID of the channel to bump in.')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('message')
                .setDescription('The reminder message to send.')
                .setRequired(true));

    client.application.commands.create(autoBumpCommand);
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand() || interaction.commandName !== 'auto-bump') return;

    const channelId = interaction.options.getString('channelid');
    const message = interaction.options.getString('message');
    const channel = await client.channels.fetch(channelId);

    if (!channel) {
        return interaction.reply({ content: 'Channel not found!', ephemeral: true });
    }

    if (bumpIntervals.has(channelId)) {
        clearInterval(bumpIntervals.get(channelId));
        bumpIntervals.delete(channelId);
        interaction.reply({ content: `Auto-bumping stopped for channel ${channel.name}.`, ephemeral: true });
    } else {
        const interval = setInterval(async () => {
            try {
                await channel.send(message);
            } catch (error) {
                console.error(`Failed to send bump message in channel ${channelId}:`, error);
                clearInterval(interval);
                bumpIntervals.delete(channelId);
            }
        }, 3600000); // 1 hour

        bumpIntervals.set(channelId, interval);
        interaction.reply({
            content: `Auto-bumping started for channel ${channel.name}. The bot will send your message every hour.
Please note that automating slash commands is against Discord's ToS. This bot will send a reminder message instead of executing the /bump command.`,
            ephemeral: true
        });
    }
});

client.login(process.env.BOT_TOKEN);
