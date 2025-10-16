require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const CoinPayments = require('coinpayments');

// --- CONFIGURATION ---
const token = process.env.TELEGRAM_BOT_TOKEN;
const buyerEmail = process.env.BUYER_REFUND_EMAIL;
const BOT_USERNAME = 'USDT2FIATXBOT'; // Your bot's actual username for referral links

// Admin Chat ID (MANDATORY: must be a string matching your Telegram user ID)
const ADMIN_CHAT_ID = '6173795597';
// Referral Constants
const REFERRAL_BONUS = 1.50; // USDT earned per successful referral
const MIN_WITHDRAW_REF = 50.00; // Minimum USDT required to withdraw referral earnings

// Minimum floor rates (guaranteed minimum)
const MIN_RATES = {
    USD: 1.05,
    EUR: 0.89,
    GBP: 0.79,
};

let currentRates = {}; // Holds the current simulated dynamic rates

// Initialize Telegram Bot
const bot = new TelegramBot(token, { polling: true });

// Initialize CoinPayments Client
// NOTE: CoinPayments is used here only for the crypto-to-fiat *selling* flow.
const coinpayments = new CoinPayments({
    key: process.env.COINPAYMENTS_PUBLIC_KEY,
    secret: process.env.COINPAYMENTS_PRIVATE_KEY,
});

// --- IN-MEMORY DATA STORES (MANDATORY: MUST BE REPLACED BY FIRESTORE IN PRODUCTION) ---

// User state and core data (Wallet, Earnings)
const userData = {};

// In-memory store for pending withdrawal requests
const withdrawalRequests = [];

// In-memory store for open support tickets
const supportLogs = {};

// In-memory store for bot's outgoing payment methods (Admin Configuration)
const adminConfig = {
    'Wise': 'wise-account@bot-email.com',
};

// --- HELPER FUNCTIONS ---

/**
 * Gets the current date and time in 24-hour format.
 * @returns {string} Formatted date and time.
 */
function getDateTime() {
    const now = new Date();
    const date = now.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    return `${date} ${time}`;
}

/**
 * Simulates fetching real-time rates, ensuring they meet the minimum floor.
 */
function getRealTimeRates() {
    // Simulate slight fluctuation above the floor
    currentRates.USDT_TO_USD = (Math.random() * 0.009 + MIN_RATES.USD).toFixed(3);
    currentRates.USDT_TO_EUR = (Math.random() * 0.009 + MIN_RATES.EUR).toFixed(3);
    currentRates.USDT_TO_GBP = (Math.random() * 0.009 + MIN_RATES.GBP).toFixed(3);
}

// Initialize rates on bot start
getRealTimeRates();


/**
 * Ensures a user's data entry exists and is initialized, including the wallet.
 * @param {number} userId The user's chat ID.
 */
function ensureUserData(userId, firstName = 'User') {
    if (!userData[userId]) {
        userData[userId] = {
            name: firstName,
            isRegistered: false,
            referredBy: null,
            earnings: 0.0,
            wallet: {
                USDT: 0.0,
                BTC: 0.0,
                ETH: 0.0,
            },
        };
    }
}

/**
 * Calculates the final fiat amount the user will receive using the direct rates.
 * @param {number} usdtAmount The amount of USDT being sold.
 * @param {string} fiatCurrency The target fiat currency ('USD', 'EUR', 'GBP').
 * @returns {string} The formatted fiat amount.
 */
function calculateFiatAmount(usdtAmount, fiatCurrency) {
    let result = 0;
    const rateKey = `USDT_TO_${fiatCurrency}`;
    const rate = parseFloat(currentRates[rateKey]);

    if (rate) {
        result = usdtAmount * rate;
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
        'Skrill': 'Please enter your **Skrill email address**.',
        'Neteller': 'Please enter your **Neteller email address**.',
        'Visa/Mastercard': 'Please enter your **Visa/Mastercard number**.\n\n⚠️ *For security, never share your full card details with untrusted parties. This is for demonstration purposes only.*',
        'Payeer': 'Please enter your **Payeer account number**.',
        'Alipay': 'Please enter your **Alipay email address**.',
    };
    return prompts[method] || 'Please provide your payment details.';
}

// --- BOT LOGIC ---

// Handler for the /start command, including deep-linking for referrals
bot.onText(/\/start\s?(.+)?/, (msg, match) => {
    const chatId = msg.chat.id;
    const firstName = msg.from.first_name || '';
    const lastName = msg.from.last_name || '';
    const username = msg.from.username ? `@${msg.from.username}` : 'N/A';
    const fullUserName = `${firstName} ${lastName}`.trim() || 'No Name';

    ensureUserData(chatId, fullUserName);
    
    // --- 1. Referral Logic (Deep Linking) ---
    if (match && match[1]) {
        const payload = match[1];
        if (payload.startsWith('ref_')) {
            const referrerId = parseInt(payload.substring(4), 10);
            
            if (referrerId && referrerId !== chatId) {
                ensureUserData(referrerId);
                
                if (!userData[chatId].isRegistered) {
                    userData[chatId].referredBy = referrerId;
                    
                    // The bonus is credited on first interaction
                    userData[referrerId].earnings += REFERRAL_BONUS;
                    
                    bot.sendMessage(referrerId, `🎉 **Referral Success!**\n\nUser ${fullUserName} has joined using your link. You earned **${REFERRAL_BONUS.toFixed(2)} USDT**! Your new total earnings are: **${userData[referrerId].earnings.toFixed(2)} USDT**.`, { parse_mode: 'Markdown' });

                    bot.sendMessage(chatId, `Welcome! You were referred by user \`${referrerId}\`.`, { parse_mode: 'Markdown' });
                }
            }
        }
    }
    
    // Mark the user as registered after their first start
    userData[chatId].isRegistered = true;
    userData[chatId].name = fullUserName;

    // --- 2. Admin Notification ---
    const adminNotification = `
*🚨 NEW USER STARTED BOT*
*ID:* \`${chatId}\`
*Name:* ${fullUserName}
*Username:* ${username}
*Referred By:* ${userData[chatId].referredBy || 'None'}
    `;
    if (chatId.toString() !== ADMIN_CHAT_ID) {
        bot.sendMessage(ADMIN_CHAT_ID, adminNotification, { parse_mode: 'Markdown' }).catch(err => {
            console.error('Failed to notify admin:', err.message);
        });
    }


    // --- 3. User Welcome Message (Enhanced Instructions) ---
    const welcomeMessage = `
*Welcome to the Crypto Exchange Bot!* 🤖

Hello *${fullUserName}*! I manage your crypto wallet and fiat exchange transactions.

*Current Time:* \`${getDateTime()}\`

---
*Main Functions:*
1.  **📊 Dashboard**: Check current rates and referral earnings.
2.  **💰 SELL USDT**: Exchange your USDT for fiat (USD, EUR, GBP).
3.  **💸 My Wallet**: Deposit and manage your BTC, ETH, and USDT holdings.

Let's begin! Please use the menu buttons below.
    `;

    bot.sendMessage(chatId, welcomeMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            keyboard: [['📊 Dashboard', '💰 SELL USDT'], ['💸 My Wallet', '🔗 Referral'], ['🆘 Support']],
            resize_keyboard: true,
            one_time_keyboard: false,
        },
    });
});

// Handler for the "Dashboard" button
bot.onText(/📊 Dashboard/, (msg) => {
    const chatId = msg.chat.id;
    ensureUserData(chatId);

    // Refresh rates on dashboard view
    getRealTimeRates();

    const ratesText = `
*📊 Exchange Dashboard*

*Current Time:* \`${getDateTime()}\`
*Your Telegram ID:* \`${chatId}\`
*Referral Earnings:* **${userData[chatId].earnings.toFixed(2)} USDT**

---
*Current Exchange Rates (USDT to Fiat):*
1 USDT = **${currentRates.USDT_TO_USD} USD**
1 USDT = **${currentRates.USDT_TO_EUR} EUR**
1 USDT = **${currentRates.USDT_TO_GBP} GBP**

*Note:* These rates are real-time, guaranteed to be equal to or better than the floor rates.
    `;

    bot.sendMessage(chatId, ratesText, { parse_mode: 'Markdown' });
});

// Handler for the "SELL USDT" button (Initiates transaction flow)
bot.onText(/💰 SELL USDT/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, 'This is your transaction wallet. Do you want to start selling your USDT now?', {
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Start Sale', callback_data: 'sell_usdt_yes' }],
                [{ text: 'Cancel', callback_data: 'sell_usdt_no' }],
            ],
        },
    });
});

// Handler for the "Referral" button or /referral command
bot.onText(/🔗 Referral|\/referral/, (msg) => {
    const chatId = msg.chat.id;
    ensureUserData(chatId);
    
    const referralLink = `https://t.me/${BOT_USERNAME}?start=ref_${chatId}`;
    const earnings = userData[chatId].earnings;
    
    const referralMessage = `
*🔗 Your Referral Dashboard*

*Current Earnings:* **${earnings.toFixed(2)} USDT**
*Minimum Withdrawal:* **${MIN_WITHDRAW_REF.toFixed(2)} USDT**
*Bonus per Referral:* **${REFERRAL_BONUS.toFixed(2)} USDT**

*Share this link to earn:*
\`${referralLink}\`

When your friends click this link and start the bot, you will automatically receive a bonus!
    `;
    
    let inlineKeyboard = [];
    if (earnings >= MIN_WITHDRAW_REF) {
        inlineKeyboard.push([{ text: `💸 Withdraw ${earnings.toFixed(2)} USDT`, callback_data: 'withdraw_ref_init' }]);
    }

    bot.sendMessage(chatId, referralMessage, { 
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard }
    });
});

// Handler for "My Wallet" button
bot.onText(/💸 My Wallet/, (msg) => {
    const chatId = msg.chat.id;
    ensureUserData(chatId);
    const wallet = userData[chatId].wallet;

    const walletMessage = `
*💸 Your Multi-Currency Wallet*

*Current Balances:*
- **USDT:** ${wallet.USDT.toFixed(8)}
- **BTC:** ${wallet.BTC.toFixed(8)}
- **ETH:** ${wallet.ETH.toFixed(8)}

What would you like to do?
    `;

    bot.sendMessage(chatId, walletMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Deposit Funds', callback_data: 'wallet_deposit_init' }],
                [{ text: 'Withdraw Funds (Admin Approved)', callback_data: 'wallet_withdraw_init' }],
            ],
        },
    });
});

// Handler for "Support" button
bot.onText(/🆘 Support/, (msg) => {
    const chatId = msg.chat.id;
    ensureUserData(chatId);
    
    userState[chatId] = { step: 'awaiting_support_message' };
    bot.sendMessage(chatId, '✍️ Please type your support message now. An administrator will be notified and respond to you as soon as possible.');
});

// Handler for Admin Command
bot.onText(/\/admin/, (msg) => {
    const chatId = msg.chat.id;

    if (chatId.toString() !== ADMIN_CHAT_ID) {
        bot.sendMessage(chatId, '🚫 Access Denied. This command is for administrators only.');
        return;
    }

    const totalUsers = Object.keys(userData).length;
    const totalEarnings = Object.values(userData).reduce((sum, user) => sum + user.earnings, 0);
    const pendingWithdrawals = withdrawalRequests.filter(req => req.status === 'Pending').length;
    const openTickets = Object.keys(supportLogs).length;

    const adminMessage = `
*👑 Admin Panel - ${getDateTime()}*

*System Statistics (In-Memory)*
*Total Registered Users:* ${totalUsers}
*Total Referral Earnings Distributed:* ${totalEarnings.toFixed(2)} USDT
*Pending Withdrawals:* ${pendingWithdrawals}
*Open Support Tickets:* ${openTickets}

Welcome, Administrator. Select an action:
    `;

    bot.sendMessage(chatId, adminMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: `💸 View Withdrawal Requests (${pendingWithdrawals})`, callback_data: 'admin_view_withdrawals' }],
                [{ text: `📩 View Support Tickets (${openTickets})`, callback_data: 'admin_view_support' }],
                [{ text: '👤 Check User Details', callback_data: 'admin_check_user' }],
                [{ text: '💳 Manage Bot Payout Methods', callback_data: 'admin_manage_methods' }],
                [{ text: 'Refresh Rates', callback_data: 'admin_refresh_rates' }],
            ],
        },
    });
});


// Handler for all inline button clicks (callback queries)
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const state = userState[chatId];

    // Acknowledge the button press
    bot.answerCallbackQuery(query.id);

    // --- ADMIN CALLBACKS (Expanded) ---
    if (chatId.toString() === ADMIN_CHAT_ID) {
        if (data === 'admin_refresh_rates') {
            getRealTimeRates();
            bot.sendMessage(chatId, `✅ Rates refreshed! New rates:\nUSD: ${currentRates.USDT_TO_USD}\nEUR: ${currentRates.USDT_TO_EUR}\nGBP: ${currentRates.USDT_TO_GBP}`);
            return;
        }
        
        if (data === 'admin_view_support') {
            const keys = Object.keys(supportLogs);
            if (keys.length === 0) {
                bot.sendMessage(chatId, '✅ No open support tickets at this time.');
                return;
            }
            const ticketId = keys[0];
            const ticket = supportLogs[ticketId];
            
            const supportMessage = `
*📩 Open Support Ticket #${ticketId}*
*User:* ${ticket.userName} (\`${ticket.userId}\`)
*Time:* ${ticket.time}
---
*Message:*
${ticket.message}
            `;

            bot.sendMessage(chatId, supportMessage, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: `➡️ Reply to User ${ticket.userId}`, callback_data: `admin_reply_init_${ticket.userId}_${ticketId}` }],
                        [{ text: '✅ Resolve Ticket', callback_data: `admin_resolve_support_${ticketId}` }],
                    ]
                }
            });
            return;
        }

        if (data.startsWith('admin_reply_init_')) {
            const parts = data.substring('admin_reply_init_'.length).split('_');
            const targetUserId = parts[0];
            const ticketId = parts[1];
            
            userState[chatId] = { step: 'awaiting_admin_reply', targetUserId: targetUserId, ticketId: ticketId };
            bot.sendMessage(chatId, `Reply mode active for User \`${targetUserId}\` (Ticket #${ticketId}). Please type your response:`, { parse_mode: 'Markdown' });
            return;
        }

        if (data.startsWith('admin_resolve_support_')) {
            const ticketId = data.substring('admin_resolve_support_'.length);
            if (supportLogs[ticketId]) {
                const user = supportLogs[ticketId].userId;
                bot.sendMessage(user, `✅ Your support ticket (Ref: #${ticketId}) has been reviewed and resolved by the administrator. Thank you.`);
                delete supportLogs[ticketId];
                bot.sendMessage(chatId, `✅ Support ticket #${ticketId} resolved and confirmation sent to user.`);
            }
            return;
        }


        if (data === 'admin_view_withdrawals') {
            const pending = withdrawalRequests.filter(req => req.status === 'Pending');
            if (pending.length === 0) {
                bot.sendMessage(chatId, '✅ No pending withdrawal requests.');
                return;
            }

            const req = pending[0];
            const withdrawalMessage = `
*💸 PENDING WITHDRAWAL REQUEST #${req.id}*
*User:* ${req.userName} (\`${req.userId}\`)
*Time:* ${req.time}
*Currency:* **${req.currency}**
*Amount:* **${req.amount.toFixed(8)}**
*Address:* \`${req.address}\`

*Action Required:*
            `;
            
            bot.sendMessage(chatId, withdrawalMessage, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '✅ Approve & Process', callback_data: `admin_approve_withdrawal_${req.id}` }],
                        [{ text: '❌ Reject & Refund', callback_data: `admin_reject_withdrawal_${req.id}` }],
                        [{ text: '➡️ Skip to Next', callback_data: 'admin_view_withdrawals' }],
                    ]
                }
            });
            return;
        }

        if (data.startsWith('admin_approve_withdrawal_')) {
            const requestId = parseInt(data.substring('admin_approve_withdrawal_'.length), 10);
            const request = withdrawalRequests.find(r => r.id === requestId && r.status === 'Pending');
            if (request) {
                request.status = 'Approved';
                // NOTE: Funds were already deducted on request.
                bot.sendMessage(request.userId, `✅ **Withdrawal Approved!**\n\nYour request for **${request.amount.toFixed(8)} ${request.currency}** to address \`${request.address}\` has been approved and the funds are being processed. This usually takes less than 5 minutes.`);
                bot.sendMessage(chatId, `✅ Request #${requestId} for ${request.amount} ${request.currency} approved. Funds sent.`);
            } else {
                bot.sendMessage(chatId, '⚠️ Request not found or already processed.');
            }
            bot.handleText(/\/admin/)(query.message); // Go back to admin menu
            return;
        }

        if (data.startsWith('admin_reject_withdrawal_')) {
            const requestId = parseInt(data.substring('admin_reject_withdrawal_'.length), 10);
            const request = withdrawalRequests.find(r => r.id === requestId && r.status === 'Pending');
            if (request) {
                request.status = 'Rejected';
                // Refund the user's wallet
                userData[request.userId].wallet[request.currency] += request.amount;
                bot.sendMessage(request.userId, `❌ **Withdrawal Rejected.**\n\nYour request for **${request.amount.toFixed(8)} ${request.currency}** has been rejected. The funds have been returned to your wallet. Please check your address and try again.`);
                bot.sendMessage(chatId, `❌ Request #${requestId} rejected. ${request.amount} ${request.currency} refunded to user's wallet.`);
            } else {
                bot.sendMessage(chatId, '⚠️ Request not found or already processed.');
            }
            bot.handleText(/\/admin/)(query.message); // Go back to admin menu
            return;
        }

        if (data === 'admin_main_menu' || data === 'admin_check_user' || data === 'admin_manage_methods' || data === 'admin_add_method_init') {
            // Re-use existing admin flow handlers
            if (data === 'admin_main_menu') bot.handleText(/\/admin/)(query.message);
            if (data === 'admin_check_user') {
                 userState[chatId] = { step: 'awaiting_admin_user_id' };
                 bot.sendMessage(chatId, 'Please enter the **Telegram User ID** you wish to lookup:', { parse_mode: 'Markdown' });
            }
            if (data === 'admin_manage_methods') {
                const methodsList = Object.keys(adminConfig).length > 0
                    ? Object.keys(adminConfig).map(key => `- *${key}*`).join('\n')
                    : '*No outgoing payment methods configured.*';
                bot.sendMessage(chatId, `*💳 Configured Payout Methods*\n\n${methodsList}`, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '➕ Add New Payout Method', callback_data: 'admin_add_method_init' }], [{ text: '⬅️ Back to Admin Panel', callback_data: 'admin_main_menu' }]], },
                });
            }
            if (data === 'admin_add_method_init') {
                userState[chatId] = { step: 'awaiting_admin_method_name' };
                bot.sendMessage(chatId, 'What is the **name** of the new payout method (e.g., Wise, US Bank, etc.)?', { parse_mode: 'Markdown' });
            }
            return;
        }
    }
    // --- END ADMIN CALLBACKS ---

    // --- TRANSACTION CANCELLATION/INITIATION ---
    if (data === 'sell_usdt_yes') {
        userState[chatId] = { step: 'awaiting_fiat' };
        getRealTimeRates();
        const ratesText = `*Select Fiat Currency*\n1 USDT = ${currentRates.USDT_TO_USD} USD\n1 USDT = ${currentRates.USDT_TO_EUR} EUR\n1 USDT = ${currentRates.USDT_TO_GBP} GBP\n\nPlease select your preferred fiat currency:`;
        bot.sendMessage(chatId, ratesText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🇺🇸 USD', callback_data: 'fiat_USD' }], [{ text: '🇪🇺 EUR', callback_data: 'fiat_EUR' }], [{ text: '🇬🇧 GBP', callback_data: 'fiat_GBP' }],], }, });
        return;
    }

    if (data === 'sell_usdt_no' || data === 'confirm_tx_no') {
        bot.sendMessage(chatId, 'Transaction cancelled. Press *💰 SELL USDT* to start a new sale.', { parse_mode: 'Markdown' });
        delete userState[chatId];
        return;
    }
    
    // --- Referral Withdrawal
    if (data === 'withdraw_ref_init') {
        bot.sendMessage(chatId, 'Please provide your **USDT TRC20 wallet address** where you would like to receive the referral funds.', { parse_mode: 'Markdown' });
        userState[chatId] = { step: 'awaiting_ref_withdraw_details', amount: userData[chatId]?.earnings || 0 };
        return;
    }

    // --- WALLET DEPOSIT/WITHDRAWAL FLOW ---
    if (data === 'wallet_deposit_init') {
        const depositMessage = `
*Select Deposit Currency*

Please select the currency you wish to deposit:
        `;
        bot.sendMessage(chatId, depositMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'USDT (TRC20)', callback_data: 'deposit_USDT' }],
                    [{ text: 'BTC', callback_data: 'deposit_BTC' }],
                    [{ text: 'ETH (ERC20)', callback_data: 'deposit_ETH' }],
                ]
            }
        });
        return;
    }

    if (data.startsWith('deposit_')) {
        const currency = data.substring(8);
        const addressMap = {
            USDT: 'TMVp32V...d3XvY', // Placeholder TRC20 address
            BTC: '1F1tA...5hH2F',   // Placeholder BTC address
            ETH: '0x32A...d1B2C',   // Placeholder ERC20 address
        };
        const network = currency === 'USDT' ? 'TRC20' : (currency === 'ETH' ? 'ERC20' : 'Bitcoin');

        const message = `
*Deposit ${currency} - ${network} Network*

To deposit, send funds to the following address:
*Address:* \`${addressMap[currency]}\`
*Network:* ${network}

*Important:* Only send **${currency}** on the **${network}** network to this address. Incorrect transfers cannot be recovered.
        `;
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        // NOTE: In a real system, you would track this deposit via a webhook and credit the user's wallet.
        return;
    }

    if (data === 'wallet_withdraw_init') {
        userState[chatId] = { step: 'awaiting_withdraw_currency' };
        bot.sendMessage(chatId, 'Select the currency you wish to withdraw:', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'USDT', callback_data: 'withdraw_USDT' }],
                    [{ text: 'BTC', callback_data: 'withdraw_BTC' }],
                    [{ text: 'ETH', callback_data: 'withdraw_ETH' }],
                ]
            }
        });
        return;
    }

    if (data.startsWith('withdraw_')) {
        if (!state || state.step !== 'awaiting_withdraw_currency') return;
        
        const currency = data.substring(9);
        const balance = userData[chatId].wallet[currency];

        if (balance <= 0.00000001) {
            bot.sendMessage(chatId, `⚠️ Your current **${currency}** balance is zero. Please deposit funds first.`);
            delete userState[chatId];
            return;
        }

        state.currency = currency;
        state.step = 'awaiting_withdraw_amount';
        bot.sendMessage(chatId, `You have **${balance.toFixed(8)} ${currency}** available.\n\n*What amount would you like to withdraw?* (Max: ${balance.toFixed(8)})`, { parse_mode: 'Markdown' });
        return;
    }
    // --- END WALLET FLOW ---

    // --- EXISTING SELL USDT FLOW CONTINUES ---
    if (data.startsWith('fiat_') || data.startsWith('network_') || data.startsWith('method_') || data.startsWith('region_')) {
        // This handles the multi-step transaction process for selling USDT
        
        // Step: Awaiting Fiat
        if (data.startsWith('fiat_')) {
            if (!state || state.step !== 'awaiting_fiat') return;
            state.fiat = data.split('_')[1];
            state.step = 'awaiting_network';
            bot.sendMessage(chatId, 'Please select the deposit network for your USDT:', { reply_markup: { inline_keyboard: [[{ text: 'USDT TRC20 (Tron)', callback_data: 'network_TRC20' }], [{ text: 'USDT ERC20 (Ethereum)', callback_data: 'network_ERC20' }],], }, });
            return;
        }

        // Step: Awaiting Network
        if (data.startsWith('network_')) {
            if (!state || state.step !== 'awaiting_network') return;
            state.network = `USDT.${data.split('_')[1]}`;
            state.step = 'awaiting_payment_method';
            bot.sendMessage(chatId, 'How would you like to receive your funds? Select a payment method:', { reply_markup: { inline_keyboard: [[{ text: 'Wise', callback_data: 'method_Wise' }, { text: 'Revolut', callback_data: 'method_Revolut' }], [{ text: 'PayPal', callback_data: 'method_PayPal' }, { text: 'Bank Transfer', callback_data: 'method_Bank Transfer' }], [{ text: 'Skrill/Neteller', callback_data: 'method_Skrill/Neteller' }, { text: 'Visa/Mastercard', callback_data: 'method_Visa/Mastercard' }], [{ text: 'Payeer', callback_data: 'method_Payeer' }, { text: 'Alipay', callback_data: 'method_Alipay' }],], }, });
            return;
        }

        // Step: Awaiting Payment Method (and Bank/Skrill sub-menus)
        if (data.startsWith('method_')) {
            if (!state || state.step !== 'awaiting_payment_method') return;
            const method = data.substring(7);
            
            if (method === 'Skrill/Neteller') {
                bot.sendMessage(chatId, 'Do you want to receive funds via Skrill or Neteller?', { reply_markup: { inline_keyboard: [[{ text: 'Skrill', callback_data: 'method_Skrill' }], [{ text: 'Neteller', callback_data: 'method_Neteller' }],], }, });
                return;
            }

            if (method === 'Bank Transfer') {
                state.step = 'awaiting_bank_region';
                bot.sendMessage(chatId, 'Is this bank account for a **European (IBAN/SWIFT)** or **US (Routing/Account)** transfer?', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🇪🇺 European Bank', callback_data: 'region_EUR' }], [{ text: '🇺🇸 US Bank', callback_data: 'region_US' }],], }, });
                return;
            }
            
            state.paymentMethod = method;
            state.step = 'awaiting_payment_details';
            const prompt = getPaymentDetailsPrompt(method);
            bot.sendMessage(chatId, prompt, { parse_mode: 'Markdown' });
            return;
        }

        // Step: Awaiting Bank Region
        if (data.startsWith('region_')) {
            if (!state || state.step !== 'awaiting_bank_region') return;
            const region = data.split('_')[1];
            state.step = 'awaiting_payment_details';
            
            if (region === 'EUR') {
                state.paymentMethod = 'European Bank Transfer';
                bot.sendMessage(chatId, '*Please provide your European bank account details:*\n\n`Your First and Last Name`\n`IBAN`\n`SWIFT CODE`\n\nPlease send all three fields in a single message.', { parse_mode: 'Markdown' });
            } else if (region === 'US') {
                state.paymentMethod = 'US Bank Transfer';
                bot.sendMessage(chatId, '*Please provide your US bank account details:*\n\n`Your First and Last Name`\n`Routing Number`\n`Account Number`\n\nPlease send all three fields in a single message.', { parse_mode: 'Markdown' });
            } else {
                bot.sendMessage(chatId, '⚠️ Invalid selection. Please try again or cancel the transaction.');
                delete userState[chatId];
            }
            return;
        }
    }


    // --- STEP: FINAL TRANSACTION CONFIRMATION ---
    if (data === 'confirm_tx_yes') {
        if (!state || state.step !== 'awaiting_confirmation') {
            bot.sendMessage(chatId, '⚠️ Error: Please start a new transaction using the *💰 SELL USDT* button.', { parse_mode: 'Markdown' });
            delete userState[chatId];
            return;
        }

        // CoinPayments Generation Logic (Mocked for non-live environment)
        try {
            const options = {
                currency1: 'USDT',
                currency2: state.network,
                amount: state.usdtAmount,
                buyer_email: buyerEmail,
                custom: chatId.toString(), 
            };

            // This simulates CoinPayments API call. Since we can't run the API here,
            // we will create a mock response for the deposit address.
            const result = {
                address: 'TMVp32V...d3XvY',
                amount: state.usdtAmount,
                timeout: 3600,
                qrcode_url: `https://placehold.co/150x150/000/fff?text=QR+Code`,
            };
            // const result = await coinpayments.createTransaction(options);
            
            const depositMessage = `
✅ *Deposit Request Created!*

To complete the transaction, please send exactly \`${result.amount}\` USDT to the address below.

*Address:*
\`${result.address}\`

*Network:* \`${state.network}\`

This address is valid for *${Math.round(result.timeout / 3600)} hours*. Do not send funds after it has expired.

Once your deposit is confirmed, the payout will proceed automatically, and you can expect to receive your funds within **5 minutes**.
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
            delete userState[chatId];
        }
    }
});


// Handler for text messages (multi-purpose)
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const fullUserName = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() || 'No Name';
    
    // Ignore commands and menu button presses
    if (msg.text.startsWith('/') || ['📊 Dashboard', '💰 SELL USDT', '💸 My Wallet', '🔗 Referral', '🆘 Support'].includes(msg.text)) return;
    if (!userState[chatId] || !userState[chatId].step) return;

    const state = userState[chatId];
    
    // --- ADMIN Message Handlers ---
    if (chatId.toString() === ADMIN_CHAT_ID && state) {
        // Admin: Look up User ID
        if (state.step === 'awaiting_admin_user_id') {
            const targetUserId = parseInt(msg.text.trim(), 10);
            if (isNaN(targetUserId)) { bot.sendMessage(chatId, '⚠️ Invalid input. Please enter a numerical Telegram User ID.'); return; }
            const userDataInfo = userData[targetUserId];
            if (userDataInfo) {
                const userDetails = `*👤 User Details for ID \`${targetUserId}\`*\n*Name:* ${userDataInfo.name}\n*Registered:* ${userDataInfo.isRegistered ? 'Yes' : 'No'}\n*Ref Earnings:* ${userDataInfo.earnings.toFixed(2)} USDT\n*Wallet Balances:*\n - USDT: ${userDataInfo.wallet.USDT.toFixed(8)}\n - BTC: ${userDataInfo.wallet.BTC.toFixed(8)}\n - ETH: ${userDataInfo.wallet.ETH.toFixed(8)}\n*Referred By ID:* ${userDataInfo.referredBy || 'N/A'}`;
                bot.sendMessage(chatId, userDetails, { parse_mode: 'Markdown' });
            } else { bot.sendMessage(chatId, `❌ User ID \`${targetUserId}\` not found in memory.`); }
            delete userState[chatId];
            return;
        }

        // Admin: Add Payout Method Name
        if (state.step === 'awaiting_admin_method_name') {
            const methodName = msg.text.trim();
            if (methodName.length < 3) { bot.sendMessage(chatId, '⚠️ Method name is too short. Please enter a descriptive name (e.g., Wise, US Bank).'); return; }
            state.newMethodName = methodName;
            state.step = 'awaiting_admin_method_details';
            bot.sendMessage(chatId, `Got it. The method is **${state.newMethodName}**.\n\nNow, please send the **full account details** for this method (e.g., IBAN/SWIFT, email, account number).`, { parse_mode: 'Markdown' });
            return;
        }

        // Admin: Add Payout Method Details
        if (state.step === 'awaiting_admin_method_details') {
            const details = msg.text.trim();
            const methodName = state.newMethodName;
            adminConfig[methodName] = details;
            bot.sendMessage(chatId, `✅ **Payout Method Added!**\n\n*Method Name:* \`${methodName}\`\n*Details Stored:*\n\`\`\`\n${details}\n\`\`\``, { parse_mode: 'Markdown' });
            delete userState[chatId];
            return;
        }

        // Admin: Reply to Support Ticket
        if (state.step === 'awaiting_admin_reply') {
            const targetUserId = state.targetUserId;
            const replyMessage = msg.text;
            
            // Relay the message to the user
            bot.sendMessage(targetUserId, `*--- Admin Reply to Ticket #${state.ticketId} ---*\n\n${replyMessage}\n\n*Reference: ${state.ticketId}*`, { parse_mode: 'Markdown' });
            
            bot.sendMessage(chatId, `✅ Reply sent to user \`${targetUserId}\`. You can now resolve the ticket.`, {
                 reply_markup: {
                    inline_keyboard: [[{ text: '✅ Resolve Ticket', callback_data: `admin_resolve_support_${state.ticketId}` }]]
                }
            });
            delete userState[chatId];
            return;
        }
    }
    // --- END ADMIN Message Handlers ---
    
    // --- Support Message Handling ---
    if (state.step === 'awaiting_support_message') {
        const ticketId = Math.floor(Math.random() * 90000) + 10000;
        supportLogs[ticketId] = {
            id: ticketId,
            userId: chatId,
            userName: fullUserName,
            message: msg.text,
            time: getDateTime(),
            status: 'Open'
        };

        const adminSupportNotification = `
*🆘 NEW SUPPORT TICKET #${ticketId}*
*User:* ${fullUserName} (\`${chatId}\`)
*Time:* ${getDateTime()}
---
*Message:*
${msg.text}
        `;
        bot.sendMessage(ADMIN_CHAT_ID, adminSupportNotification, { parse_mode: 'Markdown' }).then(() => {
            bot.sendMessage(chatId, `✅ Your support message has been sent to the admin. Your ticket ID is **#${ticketId}**. We will respond shortly!`);
        });
        delete userState[chatId];
        return;
    }

    // --- Referral Withdrawal Processing ---
    if (state.step === 'awaiting_ref_withdraw_details') {
        const walletAddress = msg.text.trim();
        if (walletAddress.length < 30) { bot.sendMessage(chatId, '⚠️ That doesn\'t look like a valid TRC20 wallet address. Please try again.'); return; }
        const withdrawalAmount = state.amount;
        
        // Log withdrawal request for admin to manually process
        const adminWithdrawalRequest = `*💸 REFERRAL WITHDRAWAL REQUEST*\n*User:* ${fullUserName} (\`${chatId}\`)\n*Amount:* **${withdrawalAmount.toFixed(2)} USDT**\n*Wallet Address (TRC20):* \`${walletAddress}\`\n*Status:* PENDING MANUAL REVIEW`;
        
        bot.sendMessage(ADMIN_CHAT_ID, adminWithdrawalRequest, { parse_mode: 'Markdown' }).then(() => {
            userData[chatId].earnings = 0; // Reset earnings after request
            bot.sendMessage(chatId, `✅ Withdrawal request for **${withdrawalAmount.toFixed(2)} USDT** has been submitted to the admin.\n\nFunds will be sent to your TRC20 address (\`${walletAddress}\`) shortly. Your referral balance is now **0.00 USDT**.`);
            delete userState[chatId];
        });
        return;
    }
    
    // --- Wallet Withdrawal Processing ---
    if (state.step === 'awaiting_withdraw_amount') {
        const amount = parseFloat(msg.text);
        const currency = state.currency;
        const balance = userData[chatId].wallet[currency];

        if (isNaN(amount) || amount <= 0 || amount > balance) {
            bot.sendMessage(chatId, `⚠️ Invalid amount. Please enter a valid amount between 0 and ${balance.toFixed(8)} ${currency}.`);
            return;
        }

        state.amount = amount;
        state.step = 'awaiting_withdraw_address';
        const network = currency === 'USDT' ? 'TRC20' : (currency === 'ETH' ? 'ERC20' : 'Bitcoin');
        bot.sendMessage(chatId, `Great! You are withdrawing **${amount.toFixed(8)} ${currency}**.\n\nPlease enter the correct **${currency} ${network} wallet address** to receive the funds.`);
        return;
    }

    if (state.step === 'awaiting_withdraw_address') {
        const address = msg.text.trim();
        if (address.length < 20) {
            bot.sendMessage(chatId, '⚠️ That address seems too short. Please double-check and enter a valid address.');
            return;
        }

        // Deduct funds from user's wallet immediately (Pending approval)
        userData[chatId].wallet[state.currency] -= state.amount;
        
        const requestId = withdrawalRequests.length + 1;
        
        const request = {
            id: requestId,
            userId: chatId,
            userName: fullUserName,
            currency: state.currency,
            amount: state.amount,
            address: address,
            time: getDateTime(),
            status: 'Pending',
            type: 'Wallet',
        };
        withdrawalRequests.push(request);

        // Notify Admin
        const adminMessage = `
*💸 NEW WALLET WITHDRAWAL REQUEST #${requestId}*
*User:* ${fullUserName} (\`${chatId}\`)
*Amount:* **${request.amount.toFixed(8)} ${request.currency}**
*Address:* \`${address}\`
*Status:* PENDING ADMIN APPROVAL
        `;
        bot.sendMessage(ADMIN_CHAT_ID, adminMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: `Review Request #${requestId}`, callback_data: `admin_view_withdrawals` }]]
            }
        });

        // Confirm to User
        bot.sendMessage(chatId, `✅ **Withdrawal Request Submitted!**\n\nYour request for **${state.amount.toFixed(8)} ${state.currency}** has been logged (ID: **#${requestId}**). The administrator will review and process it shortly. Your current balance is now **${userData[chatId].wallet[state.currency].toFixed(8)} ${state.currency}**.`);
        delete userState[chatId];
        return;
    }
    
    // --- Fiat Transaction Processing - Payment Details ---
    if (state.step === 'awaiting_payment_details') {
        state.paymentDetails = msg.text;
        state.step = 'awaiting_amount';
        bot.sendMessage(chatId, 'Excellent. Now, please enter the amount of USDT you want to sell.\n\n(Minimum: 25 USDT, Maximum: 50,000 USDT)');
        return;
    } 
    
    // --- Fiat Transaction Processing - Amount ---
    if (state.step === 'awaiting_amount') {
        const amount = parseFloat(msg.text);

        if (isNaN(amount) || amount < 25 || amount > 50000) {
            bot.sendMessage(chatId, '⚠️ Invalid amount. Please enter a number between 25 and 50,000.');
            return;
        }

        state.usdtAmount = amount;
        
        getRealTimeRates(); 
        const fiatAmount = calculateFiatAmount(amount, state.fiat);
        const finalRate = currentRates[`USDT_TO_${state.fiat}`];

        state.step = 'awaiting_confirmation';
        state.fiatAmount = fiatAmount;
        state.finalRate = finalRate;

        const summary = `
*Transaction Summary - Please Review*
*Current Time:* \`${getDateTime()}\`
---
- *Selling:* \`${state.usdtAmount} USDT\`
- *Network:* \`${state.network}\`
- *Receiving:* \`${fiatAmount} ${state.fiat}\`
- *Rate Used:* \`1 USDT = ${finalRate} ${state.fiat}\`
- *Payment Method:* \`${state.paymentMethod}\`
- *Your Details:* \`\`\`
${state.paymentDetails}
\`\`\`
---
*Please review all details carefully. Are you sure you want to proceed and generate the deposit address?*
        `;
        
        bot.sendMessage(chatId, summary, { 
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '✅ Confirm & Get Deposit Address', callback_data: 'confirm_tx_yes' }],
                    [{ text: '❌ Cancel Transaction', callback_data: 'confirm_tx_no' }],
                ],
            },
        });
        return;
    }
});

console.log('🤖 Telegram USDT Selling Bot is running...');

// Example: Simulating a user making a deposit to populate a wallet for testing.
// DO NOT include this in the final runnable code, it's for internal testing simulation.
// ensureUserData(123456789);
// userData[123456789].wallet.USDT = 100.00;
// userData[123456789].wallet.BTC = 0.05;
// userData[123456789].wallet.ETH = 1.5;
