// src/utils.js
import ccxt from 'ccxt'; // ccxt 可能仍然需要导入以访问其错误类型

/**
 * 记录日志
 * @param {'INFO' | 'WARN' | 'ERROR'} level 日志级别
 * @param {...any} message 日志消息
 */
export function log(level, ...message) {
    console.log(`[${new Date().toISOString()}] [${level}]`, ...message);
}

/**
 * 异步等待
 * @param {number} ms 等待的毫秒数
 * @returns {Promise<void>}
 */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 将数字格式化到指定精度 (四舍五入)
 * @param {number} num 输入数字
 * @param {number | undefined} precision 小数位数, undefined 则不处理
 * @returns {number} 格式化后的数字
 */
export function formatNumber(num, precision) {
    if (precision === undefined || precision < 0) {
        return num;
    }
    const factor = Math.pow(10, precision);
    return Math.round(num * factor) / factor;
}

/**
 * 将价格调整到最近的有效 Tick Size (四舍五入)
 * @param {number} price 价格
 * @param {number | undefined} tickSize 最小价格精度, undefined 则不处理
 * @returns {number} 调整后的价格
 */
export function adjustPriceToTickSize(price, tickSize) {
    if (tickSize === undefined || tickSize <= 0) {
        return price;
    }
    return Math.round(price / tickSize) * tickSize;
}

/**
 * 将数量调整到最近的有效 Step Size (向下取整)
 * @param {number} amount 数量
 * @param {number | undefined} stepSize 最小数量精度, undefined 则不处理
 * @returns {number} 调整后的数量
 */
export function adjustAmountToStepSize(amount, stepSize) {
    if (stepSize === undefined || stepSize <= 0) {
        return amount;
    }
    return Math.floor(amount / stepSize) * stepSize;
}

/**
 * 从 ccxt market 对象获取精度信息
 * @param {object | undefined} market ccxt 的 market 对象
 * @returns {{pricePrecision: number | undefined, amountPrecision: number | undefined, tickSize: number | undefined, stepSize: number | undefined, minAmount: number | undefined}} 包含精度信息的对象
 */
export function getPrecision(market) {
    const pricePrecision = market?.precision?.price;
    const amountPrecision = market?.precision?.amount;
    const tickSize = market?.precision?.price;
    const stepSize = market?.precision?.amount;
    const minAmount = market?.limits?.amount?.min;

    /**
     * 将 ccxt 的精度值 (如 0.001 或 1e-8) 转换为小数位数
     * @param {number | undefined} val 精度值
     * @returns {number | undefined} 小数位数
     */
    const getDecimalPlaces = (val) => {
        if (val === undefined) return undefined;
        const s = String(val);
        if (s.includes('e-')) {
            return parseInt(s.split('e-')[1], 10);
        }
        if (s.includes('.')) {
            // 处理像 0.000 这样的情况
            const parts = s.split('.');
            if (parts.length > 1) {
                // 确保只计算小数部分的长度
                return parts[1].length;
            }
        }
        // 如果是整数或者没有小数部分
        if (val === 1) return 0; // 特殊处理精度为1的情况，表示整数
        // 对于其他没有小数点的表示，例如直接的 10, 100，可能需要根据业务逻辑判断，这里假设它们是整数精度
        // 但 ccxt 的 precision 通常是 0.01, 1e-8 这种形式
        // 如果 val > 1 且没有小数点，可能表示整数步进，但 getDecimalPlaces 不适合处理
        // 暂时返回 0，可能需要根据具体交易所调整
        return 0;
    };


    return {
        pricePrecision: getDecimalPlaces(pricePrecision),
        amountPrecision: getDecimalPlaces(amountPrecision),
        tickSize: tickSize,
        stepSize: stepSize,
        minAmount: minAmount
    };
}