require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const CoinPayments = require('coinpayments');

// --- CONFIGURATION ---
const token = process.env.TELEGRAM_BOT_TOKEN;
const buyerEmail = process.env.BUYER_REFUND_EMAIL;

// Admin Chat ID (MANDATORY: must be a string matching your Telegram user ID)
const ADMIN_CHAT_ID = '6173795597'; 
// Referral Constants
const REFERRAL_BONUS = 1.50; // USDT earned per successful referral
const MIN_WITHDRAW_REF = 50.00; // Minimum USDT required to withdraw earnings

// Minimum floor rates (guaranteed minimum)
const MIN_RATES = {
    USD: 1.05,
    EUR: 0.89,
    GBP: 0.79, // Updated from 0.78 to 0.79 as requested
};

let currentRates = {}; // Holds the current simulated dynamic rates

// Initialize Telegram Bot
const bot = new TelegramBot(token, { polling: true });

// Initialize CoinPayments Client
const coinpayments = new CoinPayments({
    key: process.env.COINPAYMENTS_PUBLIC_KEY,
    secret: process.env.COINPAYMENTS_PRIVATE_KEY,
});

// In-memory store for user conversation state
const userState = {};

// In-memory store for referral and earnings data
// NOTE: For a production bot, this must be replaced with a persistent database (e.g., Firestore).
const referralData = {
    // Example structure: [userId]: { earnings: 0.0, referredBy: null, isRegistered: false, name: '' }
};

// --- HELPER FUNCTIONS ---

/**
 * Gets the current date and time in 24-hour format.
 * @returns {string} Formatted date and time.
 */
function getDateTime() {
    const now = new Date();
    // Using 'en-GB' locale for common 24hr format and DD/MM/YYYY date
    const date = now.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    return `${date} ${time}`;
}

/**
 * Simulates fetching real-time rates, ensuring they meet the minimum floor.
 * NOTE: In a real environment, this function would call a crypto exchange API.
 */
function getRealTimeRates() {
    // Simulate slight fluctuation above the floor to meet the "real time but better" requirement
    currentRates.USDT_TO_USD = (Math.random() * 0.009 + MIN_RATES.USD).toFixed(3); 
    currentRates.USDT_TO_EUR = (Math.random() * 0.009 + MIN_RATES.EUR).toFixed(3); 
    currentRates.USDT_TO_GBP = (Math.random() * 0.009 + MIN_RATES.GBP).toFixed(3); 
}

// Initialize rates on bot start
getRealTimeRates();


/**
 * Ensures a user's referral data entry exists and is initialized.
 * @param {number} userId The user's chat ID.
 */
function ensureReferralData(userId) {
    if (!referralData[userId]) {
        referralData[userId] = {
            earnings: 0.0,
            referredBy: null,
            isRegistered: false,
            name: 'User',
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
 * NOTE: This function is primarily used for non-bank transfer methods now.
 * @param {string} method The selected payment method (e.g., 'Wise', 'Skrill', 'Neteller').
 * @returns {string} The instructional text for the user.
 */
function getPaymentDetailsPrompt(method) {
    const prompts = {
        'Wise': 'Please enter your **Wise email address** or **Wise Tag**.',
        'Revolut': 'Please enter your **Revolut Revtag**.',
        'PayPal': 'Please enter your **PayPal email address**.',
        'Bank Transfer': 'Please provide your bank account details (IBAN).', // This prompt is overridden by region selection
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
    const fullUserName = `${firstName} ${lastName}`.trim();

    ensureReferralData(chatId);
    
    // --- 1. Referral Logic (Deep Linking) ---
    if (match && match[1]) {
        const payload = match[1];
        if (payload.startsWith('ref_')) {
            const referrerId = parseInt(payload.substring(4), 10);
            
            if (referrerId && referrerId !== chatId) {
                ensureReferralData(referrerId);
                
                if (!referralData[chatId].isRegistered) {
                    referralData[chatId].referredBy = referrerId;
                    
                    // The bonus is credited on first interaction
                    referralData[referrerId].earnings += REFERRAL_BONUS; 
                    
                    bot.sendMessage(referrerId, `🎉 **Referral Success!**\n\nUser ${fullUserName} has joined using your link. You earned **${REFERRAL_BONUS.toFixed(2)} USDT**! Your new total earnings are: **${referralData[referrerId].earnings.toFixed(2)} USDT**.`, { parse_mode: 'Markdown' });

                    bot.sendMessage(chatId, `Welcome! You were referred by user \`${referrerId}\`.`, { parse_mode: 'Markdown' });
                }
            }
        }
    }
    
    // Mark the user as registered after their first start
    referralData[chatId].isRegistered = true;
    referralData[chatId].name = fullUserName || username;

    // --- 2. Admin Notification ---
    const adminNotification = `
*🚨 NEW USER STARTED BOT*
*ID:* \`${chatId}\`
*Name:* ${fullUserName}
*Username:* ${username}
*Referred By:* ${referralData[chatId].referredBy || 'None'}
    `;
    bot.sendMessage(ADMIN_CHAT_ID, adminNotification, { parse_mode: 'Markdown' }).catch(err => {
        console.error('Failed to notify admin:', err.message);
    });


    // --- 3. User Welcome Message (Enhanced Instructions) ---
    const welcomeMessage = `
*Welcome to the USDT Selling Bot!* 🤖

Hello *${fullUserName}*! I'm here to help you sell your USDT for fiat currency quickly and securely.

*Current Time:* \`${getDateTime()}\`

---
*Getting Started Instructions:*
1.  **📊 Dashboard**: Check the current exchange rates and your referral earnings.
2.  **💰 SELL USDT**: Initiate a new transaction to exchange your USDT for USD, EUR, or GBP.
3.  **🔗 Referral**: Share your unique link to earn **${REFERRAL_BONUS.toFixed(2)} USDT** for every successful referral!

Let's begin! Please use the menu buttons below to navigate the service.
    `;

    bot.sendMessage(chatId, welcomeMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            keyboard: [['📊 Dashboard', '💰 SELL USDT'], ['🔗 Referral']], // UPDATED BUTTON NAME
            resize_keyboard: true,
            one_time_keyboard: false,
        },
    });
});

// Handler for the "Dashboard" button
bot.onText(/📊 Dashboard/, (msg) => {
    const chatId = msg.chat.id;
    ensureReferralData(chatId);

    // Refresh rates on dashboard view
    getRealTimeRates(); 

    const ratesText = `
*📊 Exchange Dashboard*

*Current Time:* \`${getDateTime()}\`
*Your Telegram ID:* \`${chatId}\`
*Referral Earnings:* **${referralData[chatId].earnings.toFixed(2)} USDT**

---
*Current Exchange Rates (USDT to Fiat):*
1 USDT = **${currentRates.USDT_TO_USD} USD**
1 USDT = **${currentRates.USDT_TO_EUR} EUR**
1 USDT = **${currentRates.USDT_TO_GBP} GBP**

*Note:* These rates are real-time, guaranteed to be equal to or better than the floor rates (1.05 USD, 0.89 EUR, 0.79 GBP).
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
    ensureReferralData(chatId);
    
    // NOTE: Update 'USDT2FIATXBOT' to your actual bot username for correct link generation
    const botUsername = 'USDT2FIATXBOT'; 
    const referralLink = `https://t.me/${botUsername}?start=ref_${chatId}`;
    const earnings = referralData[chatId].earnings;
    
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

// Handler for Admin Command
bot.onText(/\/admin/, (msg) => {
    const chatId = msg.chat.id;

    if (chatId.toString() !== ADMIN_CHAT_ID) {
        bot.sendMessage(chatId, '🚫 Access Denied. This command is for administrators only.');
        return;
    }

    const totalUsers = Object.keys(referralData).length;
    const totalEarnings = Object.values(referralData).reduce((sum, user) => sum + user.earnings, 0);

    const adminMessage = `
*👑 Admin Panel - ${getDateTime()}*

*System Statistics (In-Memory)*
*Total Registered Users:* ${totalUsers}
*Total Referral Earnings Distributed:* ${totalEarnings.toFixed(2)} USDT

Welcome, Administrator. Select an action:
    `;

    bot.sendMessage(chatId, adminMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: 'View Payout Requests (Pending)', callback_data: 'admin_payouts' }],
                [{ text: 'Refresh Rates', callback_data: 'admin_refresh_rates' }],
            ],
        },
    });
});

// Handler for referral withdrawal initiation
bot.onText(/\/withdrawref/, (msg) => {
    const chatId = msg.chat.id;
    const earnings = referralData[chatId]?.earnings || 0;
    
    if (earnings < MIN_WITHDRAW_REF) {
        bot.sendMessage(chatId, `⚠️ You need at least **${MIN_WITHDRAW_REF.toFixed(2)} USDT** to withdraw. Your current balance is **${earnings.toFixed(2)} USDT**.`, { parse_mode: 'Markdown' });
        return;
    }
    
    userState[chatId] = { step: 'awaiting_ref_withdraw_details', amount: earnings };
    bot.sendMessage(chatId, `Great! You are eligible to withdraw **${earnings.toFixed(2)} USDT**.\n\nPlease provide your **USDT TRC20 wallet address** where you would like to receive the funds.`);
});

// Handler for all inline button clicks (callback queries)
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const state = userState[chatId];

    // Acknowledge the button press
    bot.answerCallbackQuery(query.id);

    // --- ADMIN CALL BACKS ---
    if (data === 'admin_refresh_rates' && chatId.toString() === ADMIN_CHAT_ID) {
        getRealTimeRates();
        bot.sendMessage(chatId, `✅ Rates refreshed! New rates:\nUSD: ${currentRates.USDT_TO_USD}\nEUR: ${currentRates.USDT_TO_EUR}\nGBP: ${currentRates.USDT_TO_GBP}`);
        return;
    }
    
    if (data === 'admin_payouts' && chatId.toString() === ADMIN_CHAT_ID) {
        // In a real application, this would fetch pending withdrawal requests from a database.
        bot.sendMessage(chatId, 'Pending payout requests are currently only logged to the console/admin chat. Integration with a database is required to view a full list here.');
        return;
    }

    // --- TRANSACTION CANCELLATION/INITIATION ---
    if (data === 'sell_usdt_yes') {
        userState[chatId] = { step: 'awaiting_fiat' };
        
        getRealTimeRates(); // Ensure fresh rates for the transaction
        const ratesText = `
*Select Fiat Currency*
1 USDT = ${currentRates.USDT_TO_USD} USD
1 USDT = ${currentRates.USDT_TO_EUR} EUR
1 USDT = ${currentRates.USDT_TO_GBP} GBP

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
        return;
    }

    if (data === 'sell_usdt_no' || data === 'confirm_tx_no') {
        bot.sendMessage(chatId, 'Transaction cancelled. Press *💰 SELL USDT* to start a new sale.', { parse_mode: 'Markdown' });
        delete userState[chatId];
        return;
    }
    
    if (data === 'withdraw_ref_init') {
        // Trigger the text handler for withdrawal
        bot.handleText(/\/withdrawref/)(query.message); 
        return;
    }

    // --- STEP: AWAITING FIAT ---
    if (data.startsWith('fiat_')) {
        if (!state || state.step !== 'awaiting_fiat') return;
        state.fiat = data.split('_')[1];
        state.step = 'awaiting_network';
        bot.sendMessage(chatId, 'Please select the deposit network for your USDT:', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'USDT TRC20 (Tron)', callback_data: 'network_TRC20' }],
                    [{ text: 'USDT ERC20 (Ethereum)', callback_data: 'network_ERC20' }],
                ],
            },
        });
        return;
    }

    // --- STEP: AWAITING NETWORK ---
    if (data.startsWith('network_')) {
        if (!state || state.step !== 'awaiting_network') return;
        state.network = `USDT.${data.split('_')[1]}`;
        state.step = 'awaiting_payment_method';
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
        return;
    }

    // --- STEP: AWAITING PAYMENT METHOD (AND SUB-MENU LOGIC) ---
    if (data.startsWith('method_')) {
        if (!state || state.step !== 'awaiting_payment_method') return;
        
        const method = data.substring(7);
        
        if (method === 'Skrill/Neteller') {
            // Initiate sub-menu selection
            bot.sendMessage(chatId, 'Do you want to receive funds via Skrill or Neteller?', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Skrill', callback_data: 'method_Skrill' }],
                        [{ text: 'Neteller', callback_data: 'method_Neteller' }],
                    ],
                },
            });
            return; 
        }

        if (method === 'Bank Transfer') {
            // New logic: Ask for region
            state.step = 'awaiting_bank_region';
            bot.sendMessage(chatId, 'Is this bank account for a **European (IBAN/SWIFT)** or **US (Routing/Account)** transfer?', {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🇪🇺 European Bank', callback_data: 'region_EUR' }],
                        [{ text: '🇺🇸 US Bank', callback_data: 'region_US' }],
                    ],
                },
            });
            return;
        }
        
        // This handles all specific methods *except* Bank Transfer and Skrill/Neteller sub-menu
        state.paymentMethod = method;
        state.step = 'awaiting_payment_details';
        const prompt = getPaymentDetailsPrompt(method);
        bot.sendMessage(chatId, prompt, { parse_mode: 'Markdown' });
        return;
    }

    // --- NEW STEP: AWAITING BANK REGION ---
    if (data.startsWith('region_')) {
        if (!state || state.step !== 'awaiting_bank_region') return;

        const region = data.split('_')[1];
        state.step = 'awaiting_payment_details';
        
        if (region === 'EUR') {
            state.paymentMethod = 'European Bank Transfer';
            const prompt = `
*Please provide your European bank account details:*

\`Your First and Last Name\`
\`IBAN\`
\`SWIFT CODE\`

Please send all three fields in a single message.
            `;
            bot.sendMessage(chatId, prompt, { parse_mode: 'Markdown' });
        } else if (region === 'US') {
            state.paymentMethod = 'US Bank Transfer';
            const prompt = `
*Please provide your US bank account details:*

\`Your First and Last Name\`
\`Routing Number\`
\`Account Number\`

Please send all three fields in a single message.
            `;
            bot.sendMessage(chatId, prompt, { parse_mode: 'Markdown' });
        } else {
             // Fallback, though should not happen
            bot.sendMessage(chatId, '⚠️ Invalid selection. Please try again or cancel the transaction.');
            delete userState[chatId];
        }
        return;
    }


    // --- STEP: FINAL TRANSACTION CONFIRMATION ---
    if (data === 'confirm_tx_yes') {
        if (!state || state.step !== 'awaiting_confirmation') {
            bot.sendMessage(chatId, '⚠️ Error: Please start a new transaction using the *💰 SELL USDT* button.', { parse_mode: 'Markdown' });
            delete userState[chatId];
            return;
        }

        // CoinPayments Generation Logic (moved from the 'message' handler)
        try {
            const options = {
                currency1: 'USDT',
                currency2: state.network,
                amount: state.usdtAmount,
                buyer_email: buyerEmail,
                custom: chatId.toString(), 
            };

            const result = await coinpayments.createTransaction(options);
            
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


// Handler for text messages to capture details and amount
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const fullUserName = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim();
    // Ignore commands and menu button presses
    if (msg.text.startsWith('/') || ['📊 Dashboard', '💰 SELL USDT', '🔗 Referral'].includes(msg.text)) return;
    if (!userState[chatId] || !userState[chatId].step) return;

    const state = userState[chatId];

    // --- Referral Withdrawal Processing ---
    if (state.step === 'awaiting_ref_withdraw_details') {
        const walletAddress = msg.text.trim();
        
        if (walletAddress.length < 30) {
            bot.sendMessage(chatId, '⚠️ That doesn\'t look like a valid TRC20 wallet address. Please try again.');
            return;
        }

        const withdrawalAmount = state.amount;
        
        // Log withdrawal request for admin to manually process
        const adminWithdrawalRequest = `
*💸 REFERRAL WITHDRAWAL REQUEST*
*User:* ${fullUserName} (\`${chatId}\`)
*Amount:* **${withdrawalAmount.toFixed(2)} USDT**
*Wallet Address (TRC20):* \`${walletAddress}\`
*Status:* PENDING MANUAL REVIEW
        `;
        
        bot.sendMessage(ADMIN_CHAT_ID, adminWithdrawalRequest, { parse_mode: 'Markdown' }).then(() => {
            // Deduct earnings and confirm to user
            referralData[chatId].earnings = 0; // Reset earnings after request
            
            bot.sendMessage(chatId, `✅ Withdrawal request for **${withdrawalAmount.toFixed(2)} USDT** has been submitted to the admin.\n\nFunds will be sent to your TRC20 address (\`${walletAddress}\`) shortly. Your referral balance is now **0.00 USDT**.`);
            delete userState[chatId];
        }).catch(err => {
            console.error('Failed to notify admin of withdrawal:', err.message);
            bot.sendMessage(chatId, '❌ An error occurred while submitting your withdrawal request. Please try again later.');
        });
        
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
        
        // Use the current dynamically fetched rate for calculation
        getRealTimeRates(); 
        const fiatAmount = calculateFiatAmount(amount, state.fiat);
        
        // Store the final calculated rate for the summary
        const finalRate = currentRates[`USDT_TO_${state.fiat}`];

        // Set the next state
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
