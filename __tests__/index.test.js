require('dotenv').config();

const mockClientInstance = {
    once: jest.fn((event, callback) => {
        if (event === 'ready') {
            callback();
        }
    }),
    login: jest.fn().mockResolvedValue('dummy-token'),
    application: {
        commands: {
            create: jest.fn()
        }
    },
    user: {
        tag: 'test-bot#1234'
    },
    on: jest.fn(),
    channels: {
        fetch: jest.fn().mockResolvedValue({
            name: 'test-channel',
            send: jest.fn()
        })
    }
};

jest.mock('discord.js', () => {
    const originalModule = jest.requireActual('discord.js');
    return {
        ...originalModule,
        Client: jest.fn().mockImplementation(() => mockClientInstance),
    };
});


describe('Discord Bot', () => {

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        jest.useFakeTimers();
        jest.spyOn(global, 'setInterval');
        jest.spyOn(global, 'clearInterval');
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('should initialize and log in', () => {
        const { Client } = require('discord.js');
        require('../index.js');

        expect(Client).toHaveBeenCalledTimes(1);
        expect(mockClientInstance.once).toHaveBeenCalledWith('ready', expect.any(Function));
        expect(mockClientInstance.login).toHaveBeenCalledWith(process.env.BOT_TOKEN);
    });

    test('should start auto-bumping and send a reminder message', async () => {
        const { Client } = require('discord.js');
        require('../index.js');
        const interaction = {
            isCommand: () => true,
            commandName: 'auto-bump',
            options: {
                getString: jest.fn(option => {
                    if (option === 'channelid') return '123456789';
                    if (option === 'message') return 'test message';
                })
            },
            reply: jest.fn()
        };
        const interactionCallback = mockClientInstance.on.mock.calls[0][1];
        await interactionCallback(interaction);

        expect(mockClientInstance.channels.fetch).toHaveBeenCalledWith('123456789');
        const channel = await mockClientInstance.channels.fetch();
        expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('Auto-bumping started for channel test-channel')
        }));

        expect(setInterval).toHaveBeenCalledTimes(1);
        expect(setInterval).toHaveBeenLastCalledWith(expect.any(Function), 3600000);

        jest.advanceTimersByTime(3600000);

        expect(channel.send).toHaveBeenCalledTimes(1);
        expect(channel.send).toHaveBeenCalledWith('test message');
    });

    test('should stop auto-bumping', async () => {
        const { Client } = require('discord.js');
        require('../index.js');

        // First, start the bumping
        const startInteraction = {
            isCommand: () => true,
            commandName: 'auto-bump',
            options: {
                getString: jest.fn(option => {
                    if (option === 'channelid') return '123456789';
                    if (option === 'message') return 'test message';
                })
            },
            reply: jest.fn()
        };
        const interactionCallback = mockClientInstance.on.mock.calls[0][1];
        await interactionCallback(startInteraction);

        expect(setInterval).toHaveBeenCalledTimes(1);

        // Now, stop it
        const stopInteraction = {
            isCommand: () => true,
            commandName: 'auto-bump',
            options: {
                getString: jest.fn(option => {
                    if (option === 'channelid') return '123456789';
                    if (option === 'message') return 'test message';
                })
            },
            reply: jest.fn()
        };
        await interactionCallback(stopInteraction);

        expect(clearInterval).toHaveBeenCalledTimes(1);
        expect(stopInteraction.reply).toHaveBeenCalledWith({ content: `Auto-bumping stopped for channel test-channel.`, ephemeral: true });

        const channel = await mockClientInstance.channels.fetch();
        channel.send.mockClear();

        // Make sure no more messages are sent
        jest.advanceTimersByTime(3600000);
        expect(channel.send).not.toHaveBeenCalled();
    });
});
