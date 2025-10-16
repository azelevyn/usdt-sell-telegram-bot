require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const CoinPayments = require('coinpayments');

// --- CONFIGURATION ---
const token = process.env.TELEGRAM_BOT_TOKEN;
const buyerEmail = process.env.BUYER_REFUND_EMAIL;

// Initialize Telegram Bot
const bot = new TelegramBot(token, { polling: true });

// Initialize CoinPayments Client
const coinpayments = new CoinPayments({
    key: process.env.COINPAYMENTS_PUBLIC_KEY,
    secret: process.env.COINPAYMENTS_PRIVATE_KEY,
});

// Exchange Rates (as provided)
const RATES = {
    USDT_TO_USD: 1 / 1.08, // Derived from USD to USDT: 1.08
    USD_TO_EUR: 0.89,
    USDT_TO_GBP: 0.77,
};
RATES.USDT_TO_EUR = RATES.USDT_TO_USD * RATES.USD_TO_EUR;

// In-memory store for user conversation state
const userState = {};

// --- HELPER FUNCTIONS ---

/**
 * Calculates the final fiat amount the user will receive.
 * @param {number} usdtAmount The amount of USDT being sold.
 * @param {string} fiatCurrency The target fiat currency ('USD', 'EUR', 'GBP').
 * @returns {string} The formatted fiat amount.
 */
function calculateFiatAmount(usdtAmount, fiatCurrency) {
    let result = 0;
    switch (fiatCurrency) {
        case 'USD':
            result = usdtAmount * RATES.USDT_TO_USD;
            break;
        case 'EUR':
            result = usdtAmount * RATES.USDT_TO_EUR;
            break;
        case 'GBP':
            result = usdtAmount * RATES.USDT_TO_GBP;
            break;
    }
    return result.toFixed(2);
}

/**
 * Generates the prompt for payment details based on the selected method.
 * @param {string} method The selected payment method.
 * @returns {string} The instructional text for the user.
 */
function getPaymentDetailsPrompt(method) {
    const prompts = {
        'Wise': 'Please enter your **Wise email address** or **Wise Tag**.',
        'Revolut': 'Please enter your **Revolut Revtag**.',
        'PayPal': 'Please enter your **PayPal email address**.',
        'Bank Transfer': 'Please provide your **bank account details (IBAN)**.',
        'Skrill/Neteller': 'Please enter your **Skrill or Neteller email address**.',
        'Visa/Mastercard': 'Please enter your **Visa/Mastercard number**.\n\n⚠️ *For security, never share your full card details with untrusted parties. This is for demonstration purposes only.*',
        'Payeer': 'Please enter your **Payeer account number**.',
        'Alipay': 'Please enter your **Alipay email address**.',
    };
    return prompts[method] || 'Please provide your payment details.';
}

// --- BOT LOGIC ---

// Handler for the /start command
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const firstName = msg.from.first_name || '';
    const lastName = msg.from.last_name || '';

    const welcomeMessage = `
*Welcome to the USDT Selling Bot!* 🤖

This bot allows you to securely sell your USDT for fiat currency (USD, EUR, GBP) using a variety of payment methods.

Hello *${firstName} ${lastName}*!

To begin, please use the menu below.
    `;

    bot.sendMessage(chatId, welcomeMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            keyboard: [['MENU']],
            resize_keyboard: true,
            one_time_keyboard: true,
        },
    });
});

// Handler for the "MENU" button
bot.onText(/MENU/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, 'Do you want to sell USDT?', {
        reply_markup: {
            inline_keyboard: [
                [{ text: '✅ YES', callback_data: 'sell_usdt_yes' }],
                [{ text: '❌ NO', callback_data: 'sell_usdt_no' }],
            ],
        },
    });
});

// Handler for all inline button clicks (callback queries)
bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    // Acknowledge the button press
    bot.answerCallbackQuery(query.id);

    if (data === 'sell_usdt_yes') {
        userState[chatId] = { step: 'awaiting_fiat' };
        const ratesText = `
*Current Exchange Rates:*
1 USDT ≈ ${RATES.USDT_TO_USD.toFixed(4)} USD
1 USDT ≈ ${RATES.USDT_TO_EUR.toFixed(4)} EUR
1 USDT ≈ ${RATES.USDT_TO_GBP.toFixed(4)} GBP

Please select your preferred fiat currency:
        `;
        bot.sendMessage(chatId, ratesText, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🇺🇸 USD', callback_data: 'fiat_USD' }],
                    [{ text: '🇪🇺 EUR', callback_data: 'fiat_EUR' }],
                    [{ text: '🇬🇧 GBP', callback_data: 'fiat_GBP' }],
                ],
            },
        });
    }

    if (data === 'sell_usdt_no') {
        bot.sendMessage(chatId, 'Understood. Please press MENU whenever you are ready to proceed.');
        delete userState[chatId];
    }

    if (data.startsWith('fiat_')) {
        if (!userState[chatId] || userState[chatId].step !== 'awaiting_fiat') return;
        userState[chatId].fiat = data.split('_')[1];
        userState[chatId].step = 'awaiting_network';
        bot.sendMessage(chatId, 'Please select the deposit network:', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'USDT TRC20', callback_data: 'network_TRC20' }],
                    [{ text: 'USDT ERC20', callback_data: 'network_ERC20' }],
                ],
            },
        });
    }

    if (data.startsWith('network_')) {
        if (!userState[chatId] || userState[chatId].step !== 'awaiting_network') return;
        userState[chatId].network = `USDT.${data.split('_')[1]}`;
        userState[chatId].step = 'awaiting_payment_method';
        bot.sendMessage(chatId, 'How would you like to receive your funds? Select a payment method:', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Wise', callback_data: 'method_Wise' }, { text: 'Revolut', callback_data: 'method_Revolut' }],
                    [{ text: 'PayPal', callback_data: 'method_PayPal' }, { text: 'Bank Transfer', callback_data: 'method_Bank Transfer' }],
                    [{ text: 'Skrill/Neteller', callback_data: 'method_Skrill/Neteller' }, { text: 'Visa/Mastercard', callback_data: 'method_Visa/Mastercard' }],
                    [{ text: 'Payeer', callback_data: 'method_Payeer' }, { text: 'Alipay', callback_data: 'method_Alipay' }],
                ],
            },
        });
    }

    if (data.startsWith('method_')) {
        if (!userState[chatId] || userState[chatId].step !== 'awaiting_payment_method') return;
        const method = data.substring(7);
        userState[chatId].paymentMethod = method;
        userState[chatId].step = 'awaiting_payment_details';
        const prompt = getPaymentDetailsPrompt(method);
        bot.sendMessage(chatId, prompt, { parse_mode: 'Markdown' });
    }
});

// Handler for text messages to capture details and amount
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    // Ignore commands and menu presses
    if (msg.text.startsWith('/') || msg.text === 'MENU') return;
    if (!userState[chatId] || !userState[chatId].step) return;

    const state = userState[chatId];

    if (state.step === 'awaiting_payment_details') {
        state.paymentDetails = msg.text;
        state.step = 'awaiting_amount';
        bot.sendMessage(chatId, 'Excellent. Now, please enter the amount of USDT you want to sell.\n\n(Minimum: 25 USDT, Maximum: 50,000 USDT)');
    } else if (state.step === 'awaiting_amount') {
        const amount = parseFloat(msg.text);

        if (isNaN(amount) || amount < 25 || amount > 50000) {
            bot.sendMessage(chatId, '⚠️ Invalid amount. Please enter a number between 25 and 50,000.');
            return;
        }

        state.usdtAmount = amount;
        const fiatAmount = calculateFiatAmount(amount, state.fiat);

        const summary = `
*Transaction Summary*
Please confirm your details:

- *Selling:* \`${state.usdtAmount} USDT\`
- *Network:* \`${state.network}\`
- *Receiving:* \`${fiatAmount} ${state.fiat}\`
- *Payment Method:* \`${state.paymentMethod}\`
- *Your Details:* \`${state.paymentDetails}\`

Generating your deposit address...
        `;
        bot.sendMessage(chatId, summary, { parse_mode: 'Markdown' });

        try {
            const options = {
                currency1: 'USDT',
                currency2: state.network,
                amount: state.usdtAmount,
                buyer_email: buyerEmail,
                custom: chatId.toString(), // Store chat ID for future reference (e.g., via IPN)
            };

            const result = await coinpayments.createTransaction(options);
            
            const depositMessage = `
✅ *Deposit Request Created!*

To complete the transaction, please send exactly \`${result.amount}\` USDT to the address below.

*Address:*
\`${result.address}\`

*Network:* \`${state.network}\`

This address is valid for *${Math.round(result.timeout / 3600)} hours*. Do not send funds after it has expired.

Once your deposit is confirmed, we will process your fiat payment.
            `;
            // Send the main message with the QR code
            bot.sendPhoto(chatId, result.qrcode_url, {
                caption: depositMessage,
                parse_mode: 'Markdown',
            });

        } catch (error) {
            console.error('CoinPayments API Error:', error);
            bot.sendMessage(chatId, '❌ An error occurred while creating your transaction. Please try again later.');
        } finally {
            // Clear the state for this user to start a new transaction
            delete userState[chatId];
        }
    }
});

console.log('🤖 Telegram USDT Selling Bot is running...');
