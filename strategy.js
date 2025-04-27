// src/strategy.js
import { config } from './config.js';
import { ExchangeService } from './exchange.js';
import { OrderBookAnalyzer } from './orderbook.js';
import { log, formatNumber, adjustPriceToTickSize, adjustAmountToStepSize, getPrecision, sleep } from './utils.js';
import ccxt from 'ccxt';

export class MarketMakerStrategy {
    /** @type {import('./config.js').Config} */
    config;
    /** @type {ExchangeService} */
    exchangeService;
    /** @type {OrderBookAnalyzer} */
    orderBookAnalyzer;
    /** @type {ccxt.Market | undefined} */
    market;
    /** @type {number | undefined} */
    pricePrecision;
    /** @type {number | undefined} */
    amountPrecision;
    /** @type {number | undefined} */
    tickSize;
    /** @type {number | undefined} */
    stepSize;
    /** @type {number} */
    minAmount;

    // --- 订单状态跟踪 ---
    /** @type {string | null} */
    currentBuyOrderId = null;
    /** @type {string | null} */
    currentSellOrderId = null;

    // --- 成交量跟踪 ---
    /** @type {number} */
    totalTradedBaseVolume = 0; // 总基础货币成交量 (例如 BTC)
    /** @type {number | undefined} */
    lastTradeTimestamp = undefined; // 上次获取成交记录的时间戳

    /**
     * @param {import('./config.js').Config} config 配置对象
     * @param {ExchangeService} exchangeService 交易所服务实例
     * @param {OrderBookAnalyzer} orderBookAnalyzer 订单簿分析器实例
     */
    constructor(config, exchangeService, orderBookAnalyzer) {
        this.config = config;
        this.exchangeService = exchangeService;
        this.orderBookAnalyzer = orderBookAnalyzer;

        this.market = this.exchangeService.getMarket();
        if (!this.market) {
            throw new Error("策略构造函数中市场数据不可用。");
        }
        const precision = getPrecision(this.market);
        this.pricePrecision = precision.pricePrecision;
        this.amountPrecision = precision.amountPrecision;
        this.tickSize = precision.tickSize;
        this.stepSize = precision.stepSize;
        this.minAmount = precision.minAmount ?? 0;

        log('INFO', '策略初始化精度:', { price: this.pricePrecision, amount: this.amountPrecision, tick: this.tickSize, step: this.stepSize, minAmount: this.minAmount });

        if (this.tickSize === undefined || this.stepSize === undefined) {
            log('WARN', '无法确定 Tick Size 或 Step Size。格式化可能不准确。');
        }
        // --- 库存倾斜配置验证 ---
        if (typeof this.config.inventorySkewIntensity !== 'number' || this.config.inventorySkewIntensity < 0) {
            log('WARN', `无效的 inventorySkewIntensity (${this.config.inventorySkewIntensity})。设置为 0 (无倾斜)。`);
            this.config.inventorySkewIntensity = 0;
        }
        // 确保 positionLimit 是正数，否则倾斜无意义
        if ((this.config.positionLimit ?? 0) <= 0 && this.config.inventorySkewIntensity > 0) {
            log('WARN', `库存倾斜需要正数的 positionLimit (${this.config.positionLimit})。已禁用倾斜 (强度设置为 0)。`);
            this.config.inventorySkewIntensity = 0;
        }
        // --- 结束库存倾斜配置验证 ---

        // 可选：获取初始成交记录时间戳
        // this.lastTradeTimestamp = Date.now() - (24 * 60 * 60 * 1000); // 从过去24小时开始跟踪 (按需调整)
    }

    // --- 成交量跟踪辅助函数 ---
    async updateTradedVolume() {
        // 警告：在生产环境中，每个周期都调用此函数会很快达到 API 限制。
        // 考虑降低调用频率或使用 WebSockets (watchMyTrades)。
        log('INFO', '正在更新成交量...');
        try {
            // 获取自上次已知时间戳以来的成交记录
            const trades = await this.exchangeService.exchange.fetchMyTrades(
                this.config.symbol,
                this.lastTradeTimestamp, // 'since' 参数
                undefined, // limit (可选, 让 ccxt 处理默认值)
                // { 'orderId': '...' } // 如果需要，某些交易所允许按 orderId 过滤
            );

            if (trades && trades.length > 0) {
                let newVolume = 0;
                let latestTimestamp = this.lastTradeTimestamp ?? 0;

                for (const trade of trades) {
                    // 基本检查以避免时间戳相同时可能出现的重复
                    if (trade.timestamp > (this.lastTradeTimestamp ?? 0)) {
                        // 累加成交量 (假设 trade.amount 始终是基础货币)
                        newVolume += trade.amount;
                        latestTimestamp = Math.max(latestTimestamp, trade.timestamp);
                        log('DEBUG', `发现新成交: ${trade.side} ${trade.amount} @ ${trade.price}, 时间戳: ${trade.timestamp}`);
                    }
                }

                if (newVolume > 0) {
                    this.totalTradedBaseVolume += newVolume;
                    // 更新下次获取的时间戳。增加 1ms 以防止再次获取同一笔最后的成交。
                    this.lastTradeTimestamp = latestTimestamp + 1;
                    log('INFO', `成交量增加 ${formatNumber(newVolume, this.amountPrecision)}。新的总成交量: ${formatNumber(this.totalTradedBaseVolume, this.amountPrecision)} ${this.market?.base}`);
                } else {
                    log('INFO', '自上次检查以来未发现新成交。');
                }
            } else {
                log('INFO', 'fetchMyTrades 未返回成交记录。');
            }
        } catch (error) {
            log('ERROR', '获取或更新成交量失败:', error);
            // 不一定因此停止机器人，但要记录下来。
        }
    }


    async runCycle() {
        log('INFO', '--- 开始策略周期 ---');
        try {
            // 1. 获取数据
            const [ticker, orderBook, balance, position] = await Promise.all([
                this.exchangeService.fetchTicker(),
                this.exchangeService.fetchOrderBook(this.config.orderBookDepthLevels),
                this.exchangeService.fetchQuoteBalance(),
                this.exchangeService.fetchPosition() // 确保在没有持仓时正确返回 undefined 或类似值
            ]);

            // 首先检查订单簿有效性
            if (!orderBook || !orderBook.bids || !orderBook.bids.length || !orderBook.asks || !orderBook.asks.length) {
                log('WARN', '订单簿数据缺失或不完整。跳过周期。');
                await this.cancelStaleOrdersIfNeeded(); // 尝试取消可能卡住的订单
                return;
            }
            const bestBid = orderBook.bids[0][0];
            const bestAsk = orderBook.asks[0][0];
            if (typeof bestBid !== 'number' || typeof bestAsk !== 'number') {
                log('WARN', `无法从订单簿中提取有效的最佳买卖价。买: ${bestBid}, 卖: ${bestAsk}。跳过周期。`);
                await this.cancelStaleOrdersIfNeeded();
                return;
            }

            // 记录市场状态
            log('INFO', `订单簿: 最佳买价=${bestBid}, 最佳卖价=${bestAsk}`);
            if (ticker && typeof ticker.last === 'number') {
                log('INFO', `行情: 最新价=${ticker.last}`);
            }
            log('INFO', `余额: ${formatNumber(balance, 4)} ${this.market?.quote}`); // 格式化余额显示
            // 确保 currentPositionSize 是数字，如果 undefined/null 则默认为 0
            // 尝试从 position 对象中获取合约数量，兼容不同交易所返回结构
            let currentPositionSize = position?.contracts // 标准 ccxt 字段
                ?? position?.info?.positionAmt // 币安合约常见字段
                ?? position?.info?.qty // OKX 合约常见字段
                ?? 0; // 默认为 0
            // 确保是数字类型
            currentPositionSize = Number(currentPositionSize) || 0;

            const positionSide = currentPositionSize > 0 ? 'long' : (currentPositionSize < 0 ? 'short' : 'none');
            log('INFO', `持仓: 数量=${formatNumber(currentPositionSize, this.amountPrecision)} ${this.market?.base}, 方向=${positionSide}`);


            // 2. 计算基础价格
            const depthMidPrice = this.orderBookAnalyzer.calculateDepthMidPrice(orderBook, this.config.orderBookDepthLevels);
            if (depthMidPrice === null) {
                log('ERROR', '计算深度中间价失败。跳过周期。');
                await this.cancelStaleOrdersIfNeeded();
                return;
            }
            log('INFO', `深度中间价: ${formatNumber(depthMidPrice, this.pricePrecision)}`);

            let targetSpreadAbs = depthMidPrice * this.config.targetSpreadPct;
            targetSpreadAbs = Math.max(this.config.minSpread ?? 0, Math.min(this.config.maxSpread ?? Infinity, targetSpreadAbs)); // 添加默认值处理
            log('INFO', `目标价差: ${formatNumber(targetSpreadAbs, this.pricePrecision)} (绝对值), ${this.config.targetSpreadPct * 100}% (百分比)`);

            // --- 初始目标价格 (倾斜前) ---
            let initialTargetBuyPrice = depthMidPrice - targetSpreadAbs / 2;
            let initialTargetSellPrice = depthMidPrice + targetSpreadAbs / 2;
            log('INFO', `初始目标价格 (倾斜前): 买=${formatNumber(initialTargetBuyPrice, this.pricePrecision)}, 卖=${formatNumber(initialTargetSellPrice, this.pricePrecision)}`);


            // --- 库存倾斜逻辑 ---
            let targetBuyPrice = initialTargetBuyPrice;
            let targetSellPrice = initialTargetSellPrice;
            let skewAdjustment = 0;
            const positionLimit = this.config.positionLimit ?? 0; // 获取持仓限制，提供默认值

            // 仅当倾斜强度和持仓限制都有效时才执行
            if (this.config.inventorySkewIntensity > 0 && positionLimit > 0) {
                // 计算库存相对于限制的比例 (-1 到 +1)
                let inventoryRatio = currentPositionSize / positionLimit;
                inventoryRatio = Math.max(-1, Math.min(1, inventoryRatio)); // 限制在 [-1, 1] 区间

                // 计算价格需要移动的量 (倾斜调整量)
                // 库存比例为正 (多头) -> 调整量为负 (降低中间价)
                // 库存比例为负 (空头) -> 调整量为正 (提高中间价)
                // 倾斜强度 inventorySkewIntensity 控制调整的幅度
                skewAdjustment = targetSpreadAbs * inventoryRatio * this.config.inventorySkewIntensity;

                // 将调整量应用到买卖价格上 (相当于移动了报价中心)
                targetBuyPrice = initialTargetBuyPrice - skewAdjustment;
                targetSellPrice = initialTargetSellPrice - skewAdjustment;

                log('INFO', `库存比例: ${inventoryRatio.toFixed(3)}, 倾斜强度: ${this.config.inventorySkewIntensity}`);
                log('INFO', `价格倾斜调整: ${formatNumber(skewAdjustment, this.pricePrecision)}`);
                log('INFO', `目标价格 (倾斜后): 买=${formatNumber(targetBuyPrice, this.pricePrecision)}, 卖=${formatNumber(targetSellPrice, this.pricePrecision)}`);
            } else {
                log('INFO', '库存倾斜已禁用或不适用 (检查 positionLimit 和 inventorySkewIntensity 配置)。');
            }
            // --- 结束库存倾斜逻辑 ---


            // --- 最终价格调整和验证 ---
            targetBuyPrice = adjustPriceToTickSize(targetBuyPrice, this.tickSize);
            targetSellPrice = adjustPriceToTickSize(targetSellPrice, this.tickSize);

            // 防止买价 >= 卖价
            if (targetBuyPrice >= targetSellPrice && this.tickSize) {
                log('WARN', `买价 ${formatNumber(targetBuyPrice, this.pricePrecision)} >= 卖价 ${formatNumber(targetSellPrice, this.pricePrecision)} 在四舍五入/倾斜后。尝试加宽一个 tick。`);
                // 优先降低买价
                targetBuyPrice = adjustPriceToTickSize(targetBuyPrice - this.tickSize, this.tickSize);
                // 再次检查
                if (targetBuyPrice >= targetSellPrice) {
                    // 如果仍然无效，则提高卖价
                    targetSellPrice = adjustPriceToTickSize(targetSellPrice + this.tickSize, this.tickSize);
                    if (targetBuyPrice >= targetSellPrice) {
                        log('ERROR', 'Tick 调整后仍无法确保买价 < 卖价。跳过下单。');
                        await this.cancelStaleOrdersIfNeeded();
                        return;
                    }
                }
            }
            log('INFO', `目标价格 (最终调整后): 买=${formatNumber(targetBuyPrice, this.pricePrecision)}, 卖=${formatNumber(targetSellPrice, this.pricePrecision)}`);


            // 3. 计算数量 (基本逻辑不变, 使用最终价格附近的流动性)
            const rangeTicksForLiquidity = this.config.rangeTicksForLiquidity ?? 30; // 从配置或默认值获取
            if (this.tickSize === undefined) {
                log('ERROR', 'Tick Size 未定义，无法准确计算价格附近的成交量。跳过周期。');
                await this.cancelStaleOrdersIfNeeded();
                return;
            }
            // 使用最终的目标价格计算流动性
            const volumeNearBuy = this.orderBookAnalyzer.getVolumeNearPriceTicks(orderBook.bids, targetBuyPrice, rangeTicksForLiquidity, this.tickSize);
            const volumeNearSell = this.orderBookAnalyzer.getVolumeNearPriceTicks(orderBook.asks, targetSellPrice, rangeTicksForLiquidity, this.tickSize);
            log('INFO', `最终目标价附近流动性: 买方=${formatNumber(volumeNearBuy, this.amountPrecision)}, 卖方=${formatNumber(volumeNearSell, this.amountPrecision)}`);

            // 基础挂单量计算 (使用流动性阈值)
            let buyAmount = this.config.baseAmount * Math.min(1.0, volumeNearBuy / this.config.liquidityVolumeThreshold);
            let sellAmount = this.config.baseAmount * Math.min(1.0, volumeNearSell / this.config.liquidityVolumeThreshold);

            // --- 可选：基于库存倾斜调整数量 ---
            // 示例：当有多头库存时，减少买单量，增加卖单量（反之亦然）
            // const amountSkewFactor = 1.0 - (inventoryRatio * this.config.inventorySkewIntensity * 0.5); // 示例因子，需调整
            // buyAmount *= Math.max(0, amountSkewFactor); // 确保不为负
            // sellAmount *= Math.max(0, 2.0 - amountSkewFactor); // 另一侧反向调整
            // log('INFO', `基于库存调整数量因子: ${amountSkewFactor.toFixed(3)}`);
            // --- 结束可选数量调整 ---


            // 4. 风险管理 (硬性持仓限制检查仍然保留)
            let placeBuy = true;
            let placeSell = true;
            const absPositionSize = Math.abs(currentPositionSize);

            if (positionLimit > 0) { // 仅当设置了限制时检查
                if (currentPositionSize > 0 && absPositionSize >= positionLimit) {
                    log('WARN', `持仓限制 (${positionLimit}) 已达到/超过 (多头)。阻止下新的买单。`);
                    placeBuy = false;
                    // 保留增强的卖单数量逻辑以帮助在达到限制时减少持仓
                    sellAmount = Math.max(sellAmount, absPositionSize);
                } else if (currentPositionSize < 0 && absPositionSize >= positionLimit) {
                    log('WARN', `持仓限制 (-${positionLimit}) 已达到/超过 (空头)。阻止下新的卖单。`);
                    placeSell = false;
                    // 保留增强的买单数量逻辑以帮助在达到限制时减少持仓
                    buyAmount = Math.max(buyAmount, absPositionSize);
                }
            }

            // 最终数量调整 (步长 Step Size)
            buyAmount = adjustAmountToStepSize(buyAmount, this.stepSize);
            sellAmount = adjustAmountToStepSize(sellAmount, this.stepSize);
            log('INFO', `目标数量 (调整后): 买=${formatNumber(buyAmount, this.amountPrecision)}, 卖=${formatNumber(sellAmount, this.amountPrecision)}`);

            // 名义价值检查 (Notional Value Check)
            const MIN_NOTIONAL_VALUE = this.config.minNotionalValue ?? 10; // 从配置或默认值获取
            if (placeBuy && buyAmount > 0 && (buyAmount * targetBuyPrice < MIN_NOTIONAL_VALUE)) {
                log('WARN', `计算出的买单名义价值 (${(buyAmount * targetBuyPrice).toFixed(2)}) 低于最小值 (${MIN_NOTIONAL_VALUE})。跳过买单。`);
                placeBuy = false;
                buyAmount = 0; // 设置为 0 以确保在需要时取消订单
            }
            if (placeSell && sellAmount > 0 && (sellAmount * targetSellPrice < MIN_NOTIONAL_VALUE)) {
                log('WARN', `计算出的卖单名义价值 (${(sellAmount * targetSellPrice).toFixed(2)}) 低于最小值 (${MIN_NOTIONAL_VALUE})。跳过卖单。`);
                placeSell = false;
                sellAmount = 0;
            }

            // 余额检查
            const estimatedBuyCost = buyAmount * targetBuyPrice;
            if (placeBuy && estimatedBuyCost > balance && estimatedBuyCost > 0) {
                log('WARN', `余额不足 (${formatNumber(balance, 4)}) 来下买单 (约需 ${formatNumber(estimatedBuyCost, 4)})。停止买单放置。`);
                placeBuy = false;
                buyAmount = 0; // 如果无法放置，则将金额设置为 0
            }
            // 卖方余额/持仓检查 (如果做多或持平，不能卖出超过持有的数量)
            if (placeSell && sellAmount > 0) {
                // 如果当前持有多头或零仓位
                if (currentPositionSize >= 0) {
                    // 允许少量误差 (stepSize)
                    const maxSellable = currentPositionSize + (this.stepSize ?? 0.00000001);
                    if (sellAmount > maxSellable) {
                        log('WARN', `试图卖出 ${formatNumber(sellAmount, this.amountPrecision)} 但仅持有 ${formatNumber(currentPositionSize, this.amountPrecision)}。调整卖出数量。`);
                        sellAmount = adjustAmountToStepSize(Math.max(0, currentPositionSize), this.stepSize); // 最多卖出持有的数量
                        // 再次检查调整后的数量是否有效
                        if (sellAmount < this.minAmount || (sellAmount * targetSellPrice < MIN_NOTIONAL_VALUE)) {
                            log('WARN', `调整后的卖出数量 ${formatNumber(sellAmount, this.amountPrecision)} 过小或低于名义价值。跳过卖单。`);
                            placeSell = false;
                            sellAmount = 0;
                        }
                    }
                }
                // 如果允许保证金交易并且当前是空头，此检查可能不太相关，
                // 假设保证金充足（持仓限制已处理）。
            }


            // 5. 订单管理 (使用最终倾斜后的价格和调整后的数量)
            const results = await Promise.allSettled([
                this.manageOrder('buy', placeBuy, buyAmount, targetBuyPrice),
                this.manageOrder('sell', placeSell, sellAmount, targetSellPrice)
            ]);

            // 可选：记录订单管理结果
            // log('DEBUG', '订单管理结果:', results);


            // --- 成交量跟踪 ---
            // 在生产中降低调用频率！
            await this.updateTradedVolume();


        } catch (error) {
            log('ERROR', '策略周期中出错:', error);
            if (error instanceof ccxt.AuthenticationError) {
                log('ERROR', '身份验证失败。检查 API 密钥。正在停止机器人。');
                throw error; // 向上抛出以停止主循环
            } else if (error instanceof ccxt.ExchangeNotAvailable) {
                log('WARN', '交易所暂时不可用，稍后重试...');
                await sleep(30000); // 等待 30 秒
            } else if (error instanceof ccxt.RateLimitExceeded) {
                log('WARN', '达到 API 频率限制，等待一段时间...');
                // ccxt 的 enableRateLimit 应该会自动处理，但可以手动增加等待
                await sleep(this.exchange.rateLimit ? this.exchange.rateLimit * 2 : 5000);
            }
            // 如果周期中发生重大错误，尝试取消订单
            await this.cancelStaleOrdersIfNeeded();
        } finally {
            log('INFO', '--- 结束策略周期 ---');
        }
    }

    /**
     * 使用编辑或创建来管理订单簿的单侧（买或卖）。
     * @param {'buy' | 'sell'} side 买卖方向
     * @param {boolean} shouldPlace 风险管理是否允许放置/编辑此侧订单
     * @param {number} targetAmount 订单的目标数量
     * @param {number} targetPrice 订单的目标价格
     */
    async manageOrder(side, shouldPlace, targetAmount, targetPrice) {
        const orderId = side === 'buy' ? this.currentBuyOrderId : this.currentSellOrderId;
        // 绑定正确的创建订单函数到 createFn
        const createFn = side === 'buy'
            ? this.exchangeService.createLimitBuyOrder.bind(this.exchangeService)
            : this.exchangeService.createLimitSellOrder.bind(this.exchangeService);
        const logPrefix = side.toUpperCase();

        let placeNewOrder = false; // 标记是否需要放置新订单

        // 使用格式化后的数字进行日志记录，增加可读性
        const formattedAmount = formatNumber(targetAmount, this.amountPrecision);
        const formattedPrice = formatNumber(targetPrice, this.pricePrecision);
        const minAmountFormatted = formatNumber(this.minAmount, this.amountPrecision); // 格式化最小数量

        if (orderId) { // 如果跟踪了现有的订单 ID
            // 在决定操作之前，检查目标数量是否有效
            if (targetAmount < this.minAmount) {
                log('INFO', `${logPrefix}: 目标数量 (${formattedAmount}) 低于最小值 (${minAmountFormatted})。正在取消现有订单 ${orderId}。`);
                shouldPlace = false; // 确保也不会尝试放置新的
                targetAmount = 0; // 将目标数量设为0，以触发取消逻辑
            }

            if (shouldPlace) { // 如果经过数量检查后仍允许放置/编辑
                log('INFO', `${logPrefix}: 尝试编辑现有订单 ${orderId} 为数量 ${formattedAmount} @ ${formattedPrice}`);
                try {
                    // 可选优化：先获取订单状态，如果价格和数量未变则跳过编辑
                    // const existingOrder = await this.exchangeService.fetchOrder(orderId);
                    // if (existingOrder && existingOrder.price === targetPrice && existingOrder.remaining === targetAmount) {
                    //    log('INFO', `${logPrefix}: 订单 ${orderId} 参数未变，跳过编辑。`);
                    //    return; // 无需操作
                    // }

                    // 调用 editOrder，注意使用原始（未格式化）的 targetAmount 和 targetPrice
                    // 注意: editOrder 在 ccxt 中可能不被所有交易所完全支持或行为一致
                    if (this.exchangeService.exchange.has?.['editOrder']) {
                        await this.exchangeService.editOrder( // 使用封装的 editOrder 方法
                            orderId,
                            'limit', // type 通常是 limit
                            side,
                            targetAmount,
                            targetPrice
                        );
                        log('INFO', `${logPrefix}: 订单 ${orderId} 编辑成功。`);
                        // 假设编辑后 ID 不变（对于 Binance 通常是这样）
                    } else {
                        log('WARN', `${logPrefix}: 交易所不支持 editOrder。将执行取消+创建操作。`);
                        // 如果不支持编辑，则取消旧订单并标记放置新订单
                        await this.exchangeService.cancelOrder(orderId); // 尝试取消
                        if (side === 'buy') this.currentBuyOrderId = null; else this.currentSellOrderId = null;
                        placeNewOrder = true; // 标记放置新订单
                    }


                } catch (error) {
                    log('ERROR', `${logPrefix}: 编辑订单 ${orderId} 失败:`, error);
                    // 处理特定错误：无需修改
                    if (error instanceof ccxt.ExchangeError && error.message.includes('-5027')) { // Binance: "无需修改订单"
                        log('INFO', `${logPrefix}: 订单 ${orderId} 参数未变，无需编辑。`);
                        placeNewOrder = false; // 保持现有订单ID，不放置新的
                    }
                    // 处理特定错误：订单未找到
                    else if (error instanceof ccxt.OrderNotFound || error.message.includes('Unknown order')) {
                        log('INFO', `${logPrefix}: 现有订单 ${orderId} 未找到，可能已成交/取消。`);
                        if (side === 'buy') this.currentBuyOrderId = null; else this.currentSellOrderId = null;
                        placeNewOrder = true; // 标记放置新订单
                    }
                    // 处理其他编辑错误
                    else {
                        log('WARN', `${logPrefix}: 编辑失败（其他原因），尝试取消订单 ${orderId}。`);
                        try {
                            await this.exchangeService.cancelOrder(orderId);
                        } catch (cancelError) {
                            log('ERROR', `${logPrefix}: 编辑失败后取消订单 ${orderId} 也失败:`, cancelError);
                        } finally {
                            // 无论取消是否成功，都清除 ID 并尝试放置新的
                            if (side === 'buy') this.currentBuyOrderId = null; else this.currentSellOrderId = null;
                            placeNewOrder = true;
                        }
                    }
                }
            } else { // 如果 shouldPlace 为 false (例如，风险限制、数量无效)
                log('INFO', `${logPrefix}: 条件不满足，无法编辑订单 ${orderId} (放置标志: ${shouldPlace}, 数量: ${formattedAmount})。正在取消现有订单。`);
                try {
                    await this.exchangeService.cancelOrder(orderId);
                } catch (cancelError) {
                    if (cancelError instanceof ccxt.OrderNotFound) {
                        log('INFO', `${logPrefix}: 在取消时订单 ${orderId} 未找到，可能已成交/取消。`);
                    } else {
                        log('ERROR', `${logPrefix}: 取消订单 ${orderId} 失败:`, cancelError);
                    }
                } finally {
                    // 无论取消是否成功，都清除 ID
                    if (side === 'buy') this.currentBuyOrderId = null; else this.currentSellOrderId = null;
                }
            }
        } else { // 没有跟踪现有的订单 ID
            placeNewOrder = true; // 可能需要放置新订单
        }

        // 如果需要且允许，则放置新订单
        // 再次检查 targetAmount >= minAmount，因为 placeNewOrder 可能为 true 但 targetAmount 可能无效
        if (placeNewOrder && shouldPlace && targetAmount >= this.minAmount) {
            log('INFO', `${logPrefix}: 放置新订单: ${formattedAmount} @ ${formattedPrice}`);
            try {
                const newOrder = await createFn(targetAmount, targetPrice); // 使用原始值调用 API
                if (newOrder && newOrder.id) {
                    log('INFO', `${logPrefix}: 新订单放置成功。ID: ${newOrder.id}`);
                    // 记录新订单 ID
                    if (side === 'buy') this.currentBuyOrderId = newOrder.id; else this.currentSellOrderId = newOrder.id;
                } else {
                    log('WARN', `${logPrefix}: createLimitOrder 未返回有效的订单 ID。`);
                    if (side === 'buy') this.currentBuyOrderId = null; else this.currentSellOrderId = null;
                }
            } catch (error) {
                log('ERROR', `${logPrefix}: 放置新订单失败:`, error);
                // 处理特定错误，如名义价值不足
                if (error instanceof ccxt.InvalidOrder && error.message.includes('notional')) {
                    log('ERROR', `${logPrefix}: 新订单未通过最小名义价值检查。`);
                }
                // 确保放置失败时 ID 为 null
                if (side === 'buy') this.currentBuyOrderId = null; else this.currentSellOrderId = null;
            }
        } else if (placeNewOrder) {
            // 如果 placeNewOrder 为 true，但未放置 (因为 shouldPlace=false 或 amount<minAmount)
            // 确保 ID 保持 null
            if (side === 'buy') this.currentBuyOrderId = null; else this.currentSellOrderId = null;
            // 添加日志说明为什么未放置新订单
            if (!shouldPlace) {
                log('INFO', `${logPrefix}: 跳过新订单放置，因为放置标志为 false。`);
            } else if (targetAmount < this.minAmount) {
                log('INFO', `${logPrefix}: 跳过新订单放置，因为目标数量 ${formattedAmount} 低于最小值 ${minAmountFormatted}。`);
            }
        }
    }

    /** 辅助函数：如果订单 ID 被存储但出现问题，则尝试取消订单 */
    async cancelStaleOrdersIfNeeded() {
        log('WARN', '因周期跳过，尝试取消可能过时的订单...');
        const cancelPromises = [];
        const buyId = this.currentBuyOrderId; // 临时存储 ID
        const sellId = this.currentSellOrderId; // 临时存储 ID

        if (buyId) {
            log('INFO', `正在取消可能过时的买单: ${buyId}`);
            this.currentBuyOrderId = null; // 乐观地将 ID 置空
            cancelPromises.push(
                this.exchangeService.cancelOrder(buyId).catch((err) => {
                    // 仅记录非 "未找到" 的错误，因为 ID 已置空
                    if (!(err instanceof ccxt.OrderNotFound)) {
                        log('ERROR', `取消过时买单 ${buyId} 失败:`, err);
                    } else {
                        log('INFO', `过时买单 ${buyId} 已不存在。`);
                    }
                })
            );
        }
        if (sellId) {
            log('INFO', `正在取消可能过时的卖单: ${sellId}`);
            this.currentSellOrderId = null; // 乐观地将 ID 置空
            cancelPromises.push(
                this.exchangeService.cancelOrder(sellId).catch((err) => {
                    if (!(err instanceof ccxt.OrderNotFound)) {
                        log('ERROR', `取消过时卖单 ${sellId} 失败:`, err);
                    } else {
                        log('INFO', `过时卖单 ${sellId} 已不存在。`);
                    }
                })
            );
        }
        if (cancelPromises.length > 0) {
            await Promise.allSettled(cancelPromises); // 等待所有取消尝试完成
            log('INFO', '尝试取消过时订单的操作已完成。');
        } else {
            log('INFO', '未发现需要取消的过时订单。');
        }
    }

} // 结束 MarketMakerStrategy 类