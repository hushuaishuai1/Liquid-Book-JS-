// src/orderbook.js
import { log } from './utils.js';

/**
 * @typedef {Array<[number, number]>} OrderBookSide - [price, volume][]
 */

export class OrderBookAnalyzer {

    /**
     * 计算 VWAP
     * @param {OrderBookSide | undefined} orders 买单或卖单列表
     * @param {number} levels 计算的深度层数
     * @returns {number | null} VWAP 或 null (如果无法计算)
     */
    calculateVwap(orders, levels) {
        if (!orders || orders.length === 0 || levels <= 0) {
            return null;
        }

        let totalVolume = 0;
        let weightedSum = 0;
        const depth = Math.min(orders.length, levels);

        for (let i = 0; i < depth; i++) {
            const [price, volume] = orders[i];
            if (typeof price !== 'number' || typeof volume !== 'number' || volume <= 0) continue;
            weightedSum += price * volume;
            totalVolume += volume;
        }

        if (totalVolume === 0) {
            return null;
        }

        return weightedSum / totalVolume;
    }

    /**
     * 计算深度加权中间价
     * @param {ccxt.OrderBook | undefined} orderBook 订单簿对象
     * @param {number} levels 计算 VWAP 的深度
     * @returns {number | null} 深度中间价或 null
     */
    calculateDepthMidPrice(orderBook, levels) {
        if (!orderBook) return null;
        const bidVwap = this.calculateVwap(orderBook.bids, levels);
        const askVwap = this.calculateVwap(orderBook.asks, levels);

        if (bidVwap !== null && askVwap !== null) {
            return (bidVwap + askVwap) / 2;
        }

        if (orderBook.bids?.length > 0 && orderBook.asks?.length > 0) {
            const bestBid = orderBook.bids[0][0];
            const bestAsk = orderBook.asks[0][0];
            if (typeof bestBid === 'number' && typeof bestAsk === 'number') {
                log('WARN', 'VWAP calculation failed, falling back to simple mid-price.');
                return (bestBid + bestAsk) / 2;
            }
        }

        log('ERROR', 'Could not calculate depth mid-price or fallback mid-price.');
        return null;
    }

    /**
     * 获取目标价格附近一定范围内的累计交易量
     * @param {OrderBookSide | undefined} orders 买单或卖单列表
     * @param {number} targetPrice 目标价格
     * @param {number} priceRange 价格范围 (绝对值)
     * @returns {number} 累计交易量
     */
    getVolumeNearPrice(orders, targetPrice, priceRange) {
        if (!orders || orders.length === 0 || priceRange < 0) {
            return 0;
        }

        let cumulativeVolume = 0;
        const lowerBound = targetPrice - priceRange;
        const upperBound = targetPrice + priceRange;

        for (const [price, volume] of orders) {
            if (typeof price !== 'number' || typeof volume !== 'number') continue;
            if (price >= lowerBound && price <= upperBound) {
                cumulativeVolume += volume;
            }
        }
        return cumulativeVolume;
    }

    /**
     * 获取目标价格附近一定 Tick 范围内的累计交易量
     * @param {OrderBookSide | undefined} orders 买单或卖单列表
     * @param {number} targetPrice 目标价格
     * @param {number} rangeTicks Tick 范围
     * @param {number | undefined} tickSize 最小价格精度
     * @returns {number} 累计交易量
     */
    getVolumeNearPriceTicks(orders, targetPrice, rangeTicks, tickSize) {
        if (tickSize === undefined || tickSize <= 0) {
            log('WARN', 'Invalid tickSize (<=0 or undefined) in getVolumeNearPriceTicks, returning 0.');
            return 0;
        }
        const priceRange = rangeTicks * tickSize;
        return this.getVolumeNearPrice(orders, targetPrice, priceRange);
    }
}