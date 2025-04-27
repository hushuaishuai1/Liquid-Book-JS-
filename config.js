// src/config.js
import dotenv from 'dotenv';
import path from 'path'; // 导入 path 用于构建路径
import { fileURLToPath } from 'url'; // 导入 url 用于 ES Modules 路径
import { log } from './utils.js'; // 导入 log 函数

// --- 改进 .env 加载 ---
// 获取当前文件的目录路径 (适用于 ES Modules)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 构建 .env 文件的路径 (通常在项目根目录, 即上一级目录)
const envPath = path.resolve(__dirname, '..', '.env');

// 加载 .env 文件
const result = dotenv.config({ path: envPath });

if (result.error) {
    // 如果 .env 文件不存在，这不算严重错误，但最好提示一下
    log('WARN', `.env 文件 (${envPath}) 加载失败或不存在。将依赖已存在的环境变量或默认值。错误: ${result.error.message}`);
} else {
    log('INFO', `.env 文件 (${envPath}) 加载成功。`);
}
// --- 结束 .env 加载改进 ---


/**
 * 获取环境变量，并进行类型转换和验证
 * @template T
 * @param {string} key 环境变量键名
 * @param {'string' | 'number' | 'boolean'} type 期望的类型 ('string', 'number', 'boolean')
 * @param {boolean} [required=true] 是否必需
 * @param {T} [defaultValue] 默认值 (类型应与 type 匹配)
 * @returns {T} 转换后的环境变量值
 * @throws {Error} 如果必需但未找到，或类型转换失败
 */
function getEnvVar(key, type, required = true, defaultValue) {
    const value = process.env[key];

    if (value === undefined) {
        if (required && defaultValue === undefined) {
            throw new Error(`缺少必需的环境变量: ${key}`);
        }
        log('DEBUG', `环境变量 ${key} 未设置，使用默认值: ${defaultValue}`);
        return defaultValue;
    }

    try {
        switch (type) {
            case 'string':
                return value;
            case 'number':
                const num = parseFloat(value);
                if (isNaN(num)) {
                    throw new Error(`无法将值 "${value}" 解析为数字`);
                }
                return num;
            case 'boolean':
                const lowerValue = value.toLowerCase();
                return lowerValue === 'true' || lowerValue === '1';
            default:
                throw new Error(`不支持的类型: ${type}`);
        }
    } catch (error) {
        throw new Error(`处理环境变量 ${key} 时出错: ${error.message}`);
    }
}


// --- 类型定义（更新） ---
/**
 * @typedef {object} Config
 * @property {string} apiKey
 * @property {string} secretKey
 * @property {boolean} useTestnet
 * @property {string} symbol
 * @property {string} [exchangeId='binance']
 * @property {string} [defaultMarketType='future']
 * @property {number} orderBookDepthLevels
 * @property {number} targetSpreadPct
 * @property {number} minSpread
 * @property {number} maxSpread
 * @property {number} baseAmount
 * @property {number} liquidityVolumeThreshold
 * @property {number} positionLimit
 * @property {number} interval
 * @property {number} inventorySkewIntensity // 新增
 * @property {number} rangeTicksForLiquidity // 新增
 * @property {number} minNotionalValue // 新增
 * @property {string} [password]
 */

// --- 配置对象构建（更新） ---
/** @type {Config} */
export const config = {}; // 先创建一个空对象

try {
    config.apiKey = getEnvVar('BINANCE_API_KEY', 'string', true);
    config.secretKey = getEnvVar('BINANCE_SECRET_KEY', 'string', true);
    config.useTestnet = getEnvVar('USE_TESTNET', 'boolean', false, true); // 默认使用测试网
    config.symbol = getEnvVar('SYMBOL', 'string', true, 'BTC/USDT'); // 默认 BTC/USDT
    config.exchangeId = getEnvVar('EXCHANGE_ID', 'string', false, 'binance'); // 可选，默认 binance
    config.defaultMarketType = getEnvVar('DEFAULT_MARKET_TYPE', 'string', false, 'future'); // 可选，默认 future
    config.password = getEnvVar('BINANCE_PASSWORD', 'string', false); // 可选密码

    // 数值类型
    config.orderBookDepthLevels = getEnvVar('ORDER_BOOK_DEPTH_LEVELS', 'number', false, 10);
    config.targetSpreadPct = getEnvVar('TARGET_SPREAD_PCT', 'number', false, 0.0005); // 默认 0.05%
    config.minSpread = getEnvVar('MIN_SPREAD', 'number', false, 1);
    config.maxSpread = getEnvVar('MAX_SPREAD', 'number', false, 50);
    config.baseAmount = getEnvVar('BASE_AMOUNT', 'number', false, 0.01);
    config.liquidityVolumeThreshold = getEnvVar('LIQUIDITY_VOLUME_THRESHOLD', 'number', false, 0.1);
    config.positionLimit = getEnvVar('POSITION_LIMIT', 'number', false, 0.1); // 默认 0.1
    config.interval = getEnvVar('INTERVAL', 'number', false, 5); // 默认 5 秒

    // --- 新增配置项的读取 ---
    config.inventorySkewIntensity = getEnvVar('INVENTORY_SKEW_INTENSITY', 'number', false, 0); // 默认 0 (禁用)
    config.rangeTicksForLiquidity = getEnvVar('RANGE_TICKS_FOR_LIQUIDITY', 'number', false, 30);
    config.minNotionalValue = getEnvVar('MIN_NOTIONAL_VALUE', 'number', false, 10); // 默认 10

    // --- 配置后验证 ---
    if (config.targetSpreadPct <= 0) {
        log('WARN', `TARGET_SPREAD_PCT (${config.targetSpreadPct}) 必须是正数。`);
        // 可以考虑设置一个安全值或抛出错误
    }
    if (config.inventorySkewIntensity < 0) {
        log('WARN', `INVENTORY_SKEW_INTENSITY (${config.inventorySkewIntensity}) 不能为负数，已设为 0。`);
        config.inventorySkewIntensity = 0;
    }
    if (config.positionLimit <= 0 && config.inventorySkewIntensity > 0) {
        log('WARN', `库存倾斜要求 positionLimit (${config.positionLimit}) 为正数。已禁用倾斜。`);
        config.inventorySkewIntensity = 0;
    }
    // ... 可以添加更多验证 ...

    log('INFO', '配置加载完成:', {
        symbol: config.symbol,
        useTestnet: config.useTestnet,
        exchangeId: config.exchangeId,
        interval: config.interval,
        targetSpreadPct: config.targetSpreadPct,
        positionLimit: config.positionLimit,
        inventorySkewIntensity: config.inventorySkewIntensity,
        minNotionalValue: config.minNotionalValue,
        // 避免记录敏感信息如 API Keys
    });

} catch (error) {
    log('ERROR', `加载配置时发生致命错误: ${error.message}`);
    // 在发生严重配置错误时退出程序可能更安全
    process.exit(1);
}