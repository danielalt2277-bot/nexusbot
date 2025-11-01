const fs = require('fs');
const path = require('path');

function getTokens() {
    const tokensPath = path.join(__dirname, 'tokens.txt');
    if (fs.existsSync(tokensPath)) {
        const tokens = fs.readFileSync(tokensPath, "utf-8")
            .split("\n")
            .map(token => token.trim())
            .filter(Boolean);
        return tokens.length ? tokens : null;
    }
    return null;
}

function getOAuth2URL() {
    const ClientId = process.env.CLIENT_ID;
    const redirectUrl = process.env.REDIRECT_URI;
    const scopes = "guilds.join+identify";
    if (ClientId && redirectUrl) {
        return `https://discord.com/oauth2/authorize?client_id=${ClientId}&redirect_uri=${encodeURIComponent(redirectUrl)}&response_type=code&scope=${scopes}`;
    }
    return null;
}

async function getAccessToken(code) {
    const ClientId = process.env.CLIENT_ID;
    const ClientSecret = process.env.CLIENT_SECRET;
    const redirectUrl = process.env.REDIRECT_URI;

    if (!ClientId || !ClientSecret || !redirectUrl) return null;

    const params = new URLSearchParams();
    params.append("client_id", ClientId);
    params.append("client_secret", ClientSecret);
    params.append("grant_type", "authorization_code");
    params.append("code", code);
    params.append("redirect_uri", redirectUrl);

    try {
        const response = await fetch("https://discord.com/api/oauth2/token", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: params.toString()
        });

        if (!response.ok) {
            console.error("Failed to fetch access token", response.statusText);
            return null;
        }

        const data = await response.json();
        return data.access_token || null;
    } catch (error) {
        console.error("Error fetching access token", error);
        return null;
    }
}

module.exports = { getTokens, getOAuth2URL, getAccessToken };