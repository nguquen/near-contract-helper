const Koa = require('koa');
const app = new Koa();

const body = require('koa-json-body');
const cors = require('@koa/cors');
const httpErrors = require('http-errors');

app.use(require('koa-logger')());
app.use(body({ limit: '500kb', fallback: true }));
app.use(cors({ credentials: true }));

// Middleware to passthrough HTTP errors from node
app.use(async function(ctx, next) {
    try {
        await next();
    } catch(e) {
        console.error('Error: ', e, JSON.stringify(e));
        if (e.response) {
            ctx.throw(e.response.status, e.response.text);
        }

        if (e instanceof httpErrors.Forbidden) {
            ctx.throw(e);
        }

        // TODO: Figure out which errors should be exposed to user
        ctx.throw(400, e.toString());
    }
});

const Router = require('koa-router');
const router = new Router();

const creatorKeyJson = JSON.parse(process.env.ACCOUNT_CREATOR_KEY);
const recoveryKeyJson = JSON.parse(process.env.ACCOUNT_RECOVERY_KEY);
const keyStore = {
    async getKey(networkId, accountId) {
        if (accountId == creatorKeyJson.account_id) {
            return KeyPair.fromString(creatorKeyJson.private_key);
        }
        // For account recovery purposes use recovery key when updating any account
        return KeyPair.fromString(recoveryKeyJson.private_key);
    }
};
const { connect, KeyPair } = require('nearlib');
const nearPromise = (async () => {
    const near = await connect({
        deps: { keyStore },
        masterAccount: creatorKeyJson.account_id,
        nodeUrl: process.env.NODE_URL || 'https://studio.nearprotocol.com/devnet'
    });
    return near;
})();
app.use(async (ctx, next) => {
    ctx.near = await nearPromise;
    await next();
});

const NEW_ACCOUNT_AMOUNT = process.env.NEW_ACCOUNT_AMOUNT || 10000000000;

router.post('/account', async ctx => {
    const { newAccountId, newAccountPublicKey } = ctx.request.body;
    const masterAccount = await ctx.near.account(creatorKeyJson.account_id);
    ctx.body = await masterAccount.createAccount(newAccountId, newAccountPublicKey, NEW_ACCOUNT_AMOUNT);
});

const password = require('secure-random-password');
const models = require('./models');
const FROM_PHONE = process.env.TWILIO_FROM_PHONE || '+14086179592';
const SECURITY_CODE_DIGITS = 6;

const sendSms = async ({ to, text }) => {
    if (process.env.NODE_ENV == 'production') {
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        const client = require('twilio')(accountSid, authToken);
        await client.messages
            .create({
                body: text,
                from: FROM_PHONE,
                to
            });
    } else {
        console.log('sendSms:', { to, text });
    }
};

const sendSecurityCode = async ({ phoneNumber, securityCode }) => {
    return sendSms({
        text: `Your NEAR Wallet security code is: ${securityCode}`,
        to: phoneNumber
    });
};

router.post('/account/:phoneNumber/:accountId/requestCode', async ctx => {
    const accountId = ctx.params.accountId;
    const phoneNumber = ctx.params.phoneNumber;

    const securityCode = password.randomPassword({ length: SECURITY_CODE_DIGITS, characters: password.digits });
    const [account] = await models.Account.findOrCreate({ where: { accountId, phoneNumber } });
    await account.update({ securityCode });
    // TODO: Add code expiration for improved security
    await sendSecurityCode(account);

    ctx.body = {};
});

const nacl = require('tweetnacl');
const crypto = require('crypto');
const bs58 = require('bs58');
const verifySignature = async (nearAccount, securityCode, signature) => {
    const hasher = crypto.createHash('sha256');
    hasher.update(securityCode);
    const hash = hasher.digest();
    const helperPublicKey = (await keyStore.getKey(recoveryKeyJson.account_id)).publicKey;
    const accessKeys = await nearAccount.getAccessKeys();
    if (!accessKeys.find(it => it.public_key == helperPublicKey.toString())) {
        throw Error(`Account ${nearAccount.accountId} doesn't have helper key`);
    }
    return accessKeys.some(it => {
        const publicKey = it.public_key.replace('ed25519:', '');
        return nacl.sign.detached.verify(hash, Buffer.from(signature, 'base64'), bs58.decode(publicKey));
    });
};

// TODO: Different endpoints for setup and recovery
router.post('/account/:phoneNumber/:accountId/validateCode', async ctx => {
    const { phoneNumber, accountId } = ctx.params;
    const { securityCode, signature, publicKey } = ctx.request.body;

    const account = await models.Account.findOne({ where: { accountId, phoneNumber } });
    if (!account || !account.securityCode || account.securityCode != securityCode) {
        ctx.throw(401);
    }
    if (!account.confirmed) {
        const nearAccount = await ctx.near.account(accountId);
        const isSignatureValid = await verifySignature(nearAccount, securityCode, signature);
        if (!isSignatureValid) {
            ctx.throw(401);
        }
        await account.update({ securityCode: null, confirmed: true });
    } else {
        await (await ctx.near.account(accountId)).addKey(publicKey);
        await account.update({ securityCode: null });
    }

    ctx.body = {};
});

const sendMail = async (options) => {
    if (process.env.NODE_ENV == 'production') {
        const nodemailer = require('nodemailer');
        const transport = nodemailer.createTransport({
            host: process.env.MAIL_HOST || 'smtp.ethereal.email',
            port: process.env.MAIL_PORT || 587,
            auth: {
                user: process.env.MAIL_USER || '',
                pass: process.env.MAIL_PASSWORD || ''
            }
        });
        return transport.sendMail({
            from: 'wallet@nearprotocol.com',
            ...options
        });
    } else {
        console.log('sendMail:', options);
    }
};

const WALLET_URL = process.env.WALLET_URL ||'https://wallet.nearprotocol.com';
const sendRecoveryMessage = async ({ accountId, phoneNumber, email, seedPhrase }) => {
    const recoverUrl = `${WALLET_URL}/recover-seed-phrase/${encodeURIComponent(accountId)}/${encodeURIComponent(seedPhrase)}`;
    if (phoneNumber) {
        await sendSms({
            text: `Your NEAR Wallet (${accountId}) backup link is: ${recoverUrl}\nSave this message in secure place to allow you to recover account.`,
            to: phoneNumber
        });
    } else if (email) {
        await sendMail({
            to: email,
            subject: `Important: Near Wallet Recovery Email for ${accountId}`,
            text:
`Hello ${accountId}!

Use this link to recover account:
${recoverUrl}

Alternatively use this backup phrase:
${seedPhrase}

Save this message in secure place to allow you to recover account.`
        });
    } else {
        throw new Error(`Account ${accountId} has no contact information`);
    }
};

const { parseSeedPhrase } = require('near-seed-phrase');

router.post('/account/sendRecoveryMessage', async ctx => {
    const { accountId, phoneNumber, email, seedPhrase } = ctx.request.body;

    // TODO: Validate phone or email

    // Verify that seed phrase is added to the account
    const { publicKey } = parseSeedPhrase(seedPhrase);
    const nearAccount = await ctx.near.account(accountId);
    const keys = await nearAccount.getAccessKeys();
    if (!keys.some(key => key.public_key == publicKey)) {
        ctx.throw(403, 'seed phrase doesn\'t match any access keys');
    }

    const where = { accountId };
    if (phoneNumber) {
        where.phoneNumber = phoneNumber;
    } else if (email) {
        where.email = email;
    }
    const [account] = await models.Account.findOrCreate({ where });
    await sendRecoveryMessage({ ...account.dataValues, seedPhrase });

    ctx.body = {};
});

app
    .use(router.routes())
    .use(router.allowedMethods());

if (!module.parent) {
    app.listen(process.env.PORT || 3000);
} else {
    module.exports = app;
}
