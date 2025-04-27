// src/exchange.js
import ccxt from 'ccxt';
import { log } from './utils.js';
// --- ADDED: Import proxy agents ---
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
// --- END ADDED ---

export class ExchangeService {
    /** @type {ccxt.Exchange} */
    exchange;
    /** @type {ccxt.Market | undefined} */
    market;
    /** @type {string} */
    marketSymbol;
    /** @type {import('./config.js').Config} */
    config; // JSDoc for type hint

    /**
     * @param {import('./config.js').Config} config Configuration object
     */
    constructor(config) {
        this.config = config;
        const exchangeId = config.exchangeId || 'binance'; // Default to binance if not specified
        log('INFO', `Initializing exchange: ${exchangeId}`);

        const exchangeOptions = {
            apiKey: config.apiKey,
            // Ensure the secret key name matches your config file (e.g., secretKey or secret)
            secret: config.secretKey || config.secret,
            options: {
                // Adjust defaultType based on your primary usage (spot, future, swap)
                // For Binance Futures (USD-M), 'future' is correct. For Spot, use 'spot'.
                defaultType: config.defaultMarketType || 'future', // e.g., 'future', 'spot', 'swap'
                adjustForTimeDifference: true,
            },
            enableRateLimit: true, // Good practice
            // You might want to increase timeout if experiencing RequestTimeout often
            // timeout: 30000, // Example: 30 seconds
        };

        // Add password if provided in config (for exchanges like OKX, KuCoin etc.)
        if (config.password) {
            exchangeOptions.password = config.password;
        }

        // --- ADDED: Proxy Agent Logic ---
        let agent = null;
        const socksProxyUrl = process.env.SOCKS_PROXY_URL; // e.g., socks5://127.0.0.1:1080
        const httpsProxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY; // e.g., http://127.0.0.1:1080

        log('DEBUG', `SOCKS_PROXY_URL env var: ${socksProxyUrl}`);
        log('DEBUG', `HTTPS_PROXY env var: ${process.env.HTTPS_PROXY}`);
        log('DEBUG', `HTTP_PROXY env var: ${process.env.HTTP_PROXY}`);


        if (socksProxyUrl && socksProxyUrl.startsWith('socks')) {
            log('INFO', `Attempting to use SOCKS proxy agent: ${socksProxyUrl}`);
            try {
                agent = new SocksProxyAgent(socksProxyUrl);
                log('INFO', 'SOCKS proxy agent created successfully.');
            } catch (e) {
                log('ERROR', `Failed to create SOCKS agent with URL "${socksProxyUrl}":`, e);
                // Decide if you want to fall back or throw an error
            }
        } else if (httpsProxyUrl && httpsProxyUrl.startsWith('http')) {
            log('INFO', `Attempting to use HTTP/S proxy agent: ${httpsProxyUrl}`);
            try {
                agent = new HttpsProxyAgent(httpsProxyUrl);
                log('INFO', 'HTTP/S proxy agent created successfully.');
            } catch(e) {
                log('ERROR', `Failed to create HTTP/S agent with URL "${httpsProxyUrl}":`, e);
                // Decide if you want to fall back or throw an error
            }
        } else {
            log('INFO', 'No valid SOCKS_PROXY_URL or HTTPS_PROXY/HTTP_PROXY found in environment variables. Attempting direct connection.');
        }

        if (agent) {
            // Explicitly assign the agent to the options passed to ccxt
            exchangeOptions.agent = agent;
        }
        // --- END ADDED ---


        // Instantiate the exchange class dynamically based on config
        // Ensure the exchange ID exists in ccxt
        if (!(exchangeId in ccxt)) {
            throw new Error(`Exchange ID "${exchangeId}" not found in ccxt library.`);
        }
        // @ts-ignore - CCXT types might not perfectly align with dynamic instantiation
        this.exchange = new ccxt[exchangeId](exchangeOptions);


        // Handle testnet configuration using setSandboxMode (preferred)
        if (config.useTestnet) {
            if (typeof this.exchange.setSandboxMode === 'function') {
                log('INFO', `Setting sandbox mode for ${exchangeId} via setSandboxMode()`);
                try {
                    this.exchange.setSandboxMode(true);
                } catch (e) {
                    log('ERROR', `Failed to set sandbox mode for ${exchangeId}:`, e);
                    // Consider throwing error or logging warning depending on severity
                }
            } else {
                log('WARN', `setSandboxMode() function not available for ${exchangeId}. Ensure testnet API keys are used and URLs are correctly configured if needed manually.`);
                // You might need to manually set testnet URLs in exchangeOptions for older ccxt versions or specific exchanges
                // e.g., exchangeOptions.urls = { api: { public: '...', private: '...' } };
            }
        } else {
            log('INFO', `Using ${exchangeId} Mainnet.`);
        }


        this.marketSymbol = config.symbol;
        // Initialize market later in the initialize method after loading markets
        this.market = undefined;
    }

    /**
     * Loads markets and sets the specific market object.
     * Call this after the constructor.
     */
    async initialize() {
        try {
            log('INFO', 'Loading markets...');
            // loadMarkets fetches exchange info and sets up market data
            await this.exchange.loadMarkets();
            this.market = this.exchange.market(this.marketSymbol);

            if (!this.market) {
                log('ERROR', `Market ${this.marketSymbol} not found on exchange ${this.config.exchangeId}.`);
                // Log available markets for debugging
                log('DEBUG', 'Available markets:', Object.keys(this.exchange.markets ?? {}));
                throw new Error(`Market ${this.marketSymbol} not found.`);
            }

            // Additional checks based on config/expectations
            const expectedMarketType = this.config.defaultMarketType || 'future';
            if (this.market.type !== expectedMarketType) {
                log('WARN', `Loaded market type (${this.market.type}) does not match expected default type (${expectedMarketType}). Ensure this is correct.`);
                // For futures, check contract property
                if (expectedMarketType === 'future' && !this.market.contract) {
                    throw new Error(`Market ${this.marketSymbol} is not a futures contract market as expected.`);
                }
            }


            log('INFO', `Market ${this.marketSymbol} loaded successfully. Type: ${this.market.type}, Contract: ${this.market.contract}`);
            log('INFO', `Precision - Price: ${this.market.precision?.price}, Amount: ${this.market.precision?.amount}, Base: ${this.market.precision?.base}, Quote: ${this.market.precision?.quote}`);
            log('INFO', `Limits - Amount Min: ${this.market.limits?.amount?.min}, Amount Max: ${this.market.limits?.amount?.max}`);
            log('INFO', `Limits - Price Min: ${this.market.limits?.price?.min}, Price Max: ${this.market.limits?.price?.max}`);
            log('INFO', `Limits - Cost Min: ${this.market.limits?.cost?.min}, Cost Max: ${this.market.limits?.cost?.max}`);

        } catch (error) {
            log('ERROR', 'Failed to initialize exchange service during market loading:', error);
            // Attempting to cancel orders here might fail if initialization didn't complete
            // Error is re-thrown to be caught by the main loop/caller
            throw error;
        }
    }

    getMarket() {
        if (!this.market) {
            log('WARN', 'getMarket() called before market was successfully initialized.');
        }
        return this.market;
    }

    async fetchTicker() {
        if (!this.market) throw new Error('Market not initialized');
        try {
            return await this.exchange.fetchTicker(this.marketSymbol);
        } catch (error) {
            log('ERROR', `Failed to fetch ticker for ${this.marketSymbol}:`, error);
            // Re-throw or return undefined based on how critical this is
            throw error; // Or return undefined;
        }
    }

    /**
     * @param {number} [limit=20] Depth of the order book
     * @returns {Promise<ccxt.OrderBook | undefined>}
     */
    async fetchOrderBook(limit = 20) {
        if (!this.market) throw new Error('Market not initialized');
        try {
            return await this.exchange.fetchOrderBook(this.marketSymbol, limit);
        } catch (error) {
            log('ERROR', `Failed to fetch order book for ${this.marketSymbol}:`, error);
            throw error; // Or return undefined;
        }
    }

    async fetchQuoteBalance() {
        if (!this.market) throw new Error('Market not initialized');
        try {
            const balanceParams = this.market.contract ? { type: this.market.type } : {}; // Specify type for futures/swap
            const balance = await this.exchange.fetchBalance(balanceParams);
            const quoteCurrency = this.market?.quote;
            if (!quoteCurrency) {
                log('ERROR', 'Could not determine quote currency from market');
                return 0;
            }
            // Check different balance structures (total, free, used) based on needs
            // 'free' is usually what's available for placing new orders
            // For futures margin, 'total' might be more relevant sometimes
            const quoteBalance = balance?.[quoteCurrency]?.free ?? balance?.info?.[quoteCurrency]?.availableBalance ?? balance?.free?.[quoteCurrency] ?? 0;
            log('DEBUG', `Fetched balance for ${quoteCurrency}: Free=${quoteBalance}`);
            return quoteBalance;
        } catch (error) {
            log('ERROR', 'Failed to fetch balance:', error);
            throw error; // Or return 0;
        }
    }

    async fetchPosition() {
        if (!this.market) throw new Error('Market not initialized');
        // 检查是否是合约市场，只有合约市场才有持仓概念
        if (!this.market.contract) {
            log('INFO', 'fetchPosition called for non-contract market. Returning undefined.');
            return undefined; // Positions only relevant for derivatives
        }
        try {
            log('DEBUG', `Fetching positions, requesting symbol: ${this.marketSymbol}`);
            // 始终使用 fetchPositions() 获取所有持仓或指定列表的持仓
            // 传入 [this.marketSymbol] 尝试只获取这一个，如果交易所支持的话效率更高
            // 如果传入 symbol 列表获取失败，可以不传参数获取全部再过滤
            let positions;
            try {
                // 尝试只获取目标 symbol 的持仓（复数方法，传入数组）
                positions = await this.exchange.fetchPositions([this.marketSymbol]);
            } catch (fetchError) {
                // 如果只获取单个失败 (有些交易所不支持)，尝试获取全部
                log('WARN', `Failed to fetch positions for specific symbol [${this.marketSymbol}], attempting to fetch all positions. Error: ${fetchError.message}`);
                if (this.exchange.has?.['fetchPositions']) { // 确保支持复数形式
                    positions = await this.exchange.fetchPositions(); // 获取全部
                } else {
                    log('ERROR', 'Exchange does not support fetchPositions either.');
                    throw fetchError; // 如果连复数形式都不支持，则抛出原始错误
                }
            }


            if (positions && positions.length > 0) {
                // 从返回的数组中精确查找匹配的交易对
                log('DEBUG', `Received ${positions.length} positions, searching for ${this.marketSymbol}`);
                const targetPosition = positions.find(p => p.symbol === this.marketSymbol);
                if (targetPosition) {
                    log('DEBUG', `Found position for ${this.marketSymbol}: Size=${targetPosition.contracts}, Side=${targetPosition.side}`);
                    return targetPosition; // 返回找到的持仓对象
                } else {
                    log('DEBUG', `No position found specifically for ${this.marketSymbol} within the returned list.`);
                }
            } else {
                log('DEBUG', `fetchPositions returned no data or an empty array.`);
            }
            return undefined; // 没有找到匹配的持仓

        } catch (error) {
            // 处理特定的错误，例如权限不足或 API 问题
            if (error instanceof ccxt.ExchangeError && (error.message.includes('Position does not exist') || error.message.includes('position risk'))) {
                // 这类错误通常意味着就是没有持仓，可以接受
                log('DEBUG', `No position exists for ${this.marketSymbol} (API message).`);
                return undefined;
            }
            // 其他类型的错误则记录并抛出
            log('ERROR', `Failed to fetch positions for ${this.marketSymbol}:`, error);
            throw error; // 将其他错误向上抛出，让上层逻辑处理
        }
    }

    // --- Order Methods (createLimitBuyOrder, createLimitSellOrder, cancelOrder, etc.) ---
    // These methods generally don't need changes for proxy, as the underlying
    // this.exchange instance already has the agent configured.

    /**
     * @param {number} amount Quantity
     * @param {number} price Price
     * @param {object} [params={}] Additional parameters for the order
     * @returns {Promise<ccxt.Order | undefined>}
     */
    async createLimitBuyOrder(amount, price, params = {}) {
        if (!this.market) throw new Error('Market not initialized');
        log('INFO', `Placing BUY order: ${amount} ${this.market?.base} @ ${price} ${this.market?.quote} with params: ${JSON.stringify(params)}`);
        try {
            const order = await this.exchange.createLimitBuyOrder(this.marketSymbol, amount, price, params);
            log('INFO', `BUY order placed successfully. ID: ${order.id}, ClientOrderID: ${order.clientOrderId}`);
            return order;
        } catch (error) {
            log('ERROR', `Failed to place BUY order:`, error);
            throw error; // Re-throw to be handled by caller (e.g., strategy)
        }
    }

    /**
     * @param {number} amount Quantity
     * @param {number} price Price
     * @param {object} [params={}] Additional parameters for the order
     * @returns {Promise<ccxt.Order | undefined>}
     */
    async createLimitSellOrder(amount, price, params = {}) {
        if (!this.market) throw new Error('Market not initialized');
        log('INFO', `Placing SELL order: ${amount} ${this.market?.base} @ ${price} ${this.market?.quote} with params: ${JSON.stringify(params)}`);
        try {
            const order = await this.exchange.createLimitSellOrder(this.marketSymbol, amount, price, params);
            log('INFO', `SELL order placed successfully. ID: ${order.id}, ClientOrderID: ${order.clientOrderId}`);
            return order;
        } catch (error) {
            log('ERROR', `Failed to place SELL order:`, error);
            throw error; // Re-throw
        }
    }

    /**
     * @param {string} id Order ID
     * @param {object} [params={}] Additional parameters
     * @returns {Promise<boolean>} True if successful or order not found, false otherwise
     */
    async cancelOrder(id, params = {}) {
        if (!this.market) throw new Error('Market not initialized');
        log('INFO', `Canceling order ${id} for ${this.marketSymbol} with params: ${JSON.stringify(params)}...`);
        try {
            // cancelOrder might return order structure or specific response
            const response = await this.exchange.cancelOrder(id, this.marketSymbol, params);
            log('INFO', `Cancel request for order ${id} sent successfully. Response:`, response); // Log response for debugging
            return true;
        } catch (error) {
            if (error instanceof ccxt.OrderNotFound || (error instanceof ccxt.ExchangeError && (error.message.includes('Unknown order') || error.message.includes('Order does not exist')))) {
                log('WARN', `Order ${id} not found during cancellation (already canceled/filled?).`);
                return true; // Consider not found as "success" in terms of the order being gone
            }
            log('ERROR', `Failed to cancel order ${id}:`, error);
            // Decide whether to re-throw or return false
            // Returning false might hide critical errors sometimes.
            // throw error;
            return false;
        }
    }

    /**
     * @param {object} [params={}] Additional parameters
     * @returns {Promise<boolean>} True if successful, false otherwise
     */
    async cancelAllOrders(params = {}) {
        if (!this.market) throw new Error('Market not initialized');
        log('INFO', `Canceling all open orders for ${this.marketSymbol} with params: ${JSON.stringify(params)}...`);
        try {
            const response = await this.exchange.cancelAllOrders(this.marketSymbol, params);
            log('INFO', `Cancel all orders request for ${this.marketSymbol} sent successfully. Response:`, response);
            return true;
        } catch (error) {
            log('ERROR', `Failed to cancel all orders for ${this.marketSymbol}:`, error);
            // Decide whether to re-throw or return false
            // throw error;
            return false;
        }
    }

    /**
     * @param {object} [params={}] Additional parameters
     * @returns {Promise<ccxt.Order[]>} Array of open orders
     */
    async fetchOpenOrders(params = {}) {
        if (!this.market) throw new Error('Market not initialized');
        try {
            return await this.exchange.fetchOpenOrders(this.marketSymbol, undefined, undefined, params);
        } catch (error) {
            log('ERROR', `Failed to fetch open orders for ${this.marketSymbol}:`, error);
            // Decide whether to re-throw or return empty array
            // throw error;
            return [];
        }
    }

    /**
     * Fetches a specific order by ID. Note: Requires exchange support for fetchOrder.
     * @param {string} id Order ID
     * @param {object} [params={}] Additional parameters
     * @returns {Promise<ccxt.Order | undefined>}
     */
    async fetchOrder(id, params = {}) {
        if (!this.market) throw new Error('Market not initialized');
        if (!this.exchange.has?.['fetchOrder']) {
            log('WARN', `Exchange ${this.config.exchangeId} does not support fetchOrder.`);
            return undefined;
        }
        try {
            return await this.exchange.fetchOrder(id, this.marketSymbol, params);
        } catch (error) {
            if (error instanceof ccxt.OrderNotFound) {
                log('INFO', `Order ${id} not found via fetchOrder.`);
                return undefined;
            }
            log('ERROR', `Failed to fetch order ${id}:`, error);
            // Decide whether to re-throw or return undefined
            // throw error;
            return undefined;
        }
    }

    /**
     * Edits an existing order. Note: Requires exchange support for editOrder.
     * @param {string} id Order ID to edit
     * @param {'limit'} type Order type (usually limit for edits)
     * @param {'buy' | 'sell'} side Order side
     * @param {number} amount New amount
     * @param {number} [price] New price (required for limit orders)
     * @param {object} [params={}] Additional parameters
     * @returns {Promise<ccxt.Order | undefined>} The edited order structure
     */
    async editOrder(id, type, side, amount, price, params = {}) {
        if (!this.market) throw new Error('Market not initialized');
        if (!this.exchange.has?.['editOrder']) {
            log('WARN', `Exchange ${this.config.exchangeId} does not support editOrder.`);
            // You might need to implement cancel + create logic as a fallback
            throw new ccxt.NotSupported(`editOrder not supported by ${this.config.exchangeId}`);
        }
        if (type === 'limit' && typeof price !== 'number') {
            throw new Error('Price is required for editing limit orders.');
        }
        log('INFO', `Editing order ${id}: Side=${side}, Amount=${amount}, Price=${price}, Params=${JSON.stringify(params)}`);
        try {
            // Note: The symbol parameter might vary across exchanges in editOrder,
            // ccxt usually handles this, but double-check docs if issues arise.
            const order = await this.exchange.editOrder(id, this.marketSymbol, type, side, amount, price, params);
            log('INFO', `Order ${id} edited successfully. New ID (if changed): ${order.id}`);
            return order;
        } catch (error) {
            log('ERROR', `Failed to edit order ${id}:`, error);
            // Re-throw error to be handled by the strategy's manageOrder function
            throw error;
        }
    }

} // End of ExchangeService class