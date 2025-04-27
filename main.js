// src/main.js
import { config } from './config.js';
import { ExchangeService } from './exchange.js';
import { OrderBookAnalyzer } from './orderbook.js';
import { MarketMakerStrategy } from './strategy.js';
import { log, sleep } from './utils.js';
import ccxt from 'ccxt'; // Import ccxt to access error types like TimeoutError, RateLimitExceeded etc.

let running = true;
// global exchangeService variable for cleanup
let exchangeServiceInstance = null;

async function main() {
    log('INFO', 'Starting Liquid Book Market Maker Bot (JavaScript)...');

    try {
        // Initialize services
        const exchangeService = new ExchangeService(config);
        exchangeServiceInstance = exchangeService; // Store instance for cleanup
        await exchangeService.initialize();

        const orderBookAnalyzer = new OrderBookAnalyzer();
        const strategy = new MarketMakerStrategy(config, exchangeService, orderBookAnalyzer);

        log('INFO', 'Starting main strategy loop...');
        while (running) {
            try {
                await strategy.runCycle();
            } catch (cycleError) {
                log('ERROR', 'An error occurred within the strategy cycle:', cycleError);
                // Use ccxt error types for specific handling
                if (cycleError instanceof ccxt.TimeoutError) { // Corrected error type access
                    log('WARN', 'Request timed out. Retrying after delay...');
                    await sleep(config.interval * 1000 * 2);
                } else if (cycleError instanceof ccxt.RateLimitExceeded) {
                    log('WARN', 'Rate limit exceeded. Waiting longer before retry...');
                    await sleep(60 * 1000);
                } else if (cycleError instanceof ccxt.AuthenticationError) {
                    log('ERROR', 'Authentication failed. Stopping bot.');
                    running = false;
                } else if (cycleError instanceof ccxt.ExchangeNotAvailable || cycleError instanceof ccxt.NetworkError) {
                    log('WARN', 'Network or Exchange unavailable. Retrying after longer delay...');
                    await sleep(config.interval * 1000 * 3);
                }
                // Continue loop for most other errors after a delay
            }
            if (running) {
                log('INFO', `Waiting for ${config.interval} seconds...`);
                await sleep(config.interval * 1000);
            }
        }

    } catch (error) {
        log('ERROR', 'Fatal error during initialization or unhandled loop error:', error);
        running = false;
    } finally {
        log('INFO', 'Bot shutting down or loop exited.');
        // Attempt cleanup using the stored instance
        if (exchangeServiceInstance) {
            try {
                log('INFO', 'Attempting final order cancellation...');
                await exchangeServiceInstance.cancelAllOrders();
                log('INFO', 'Final orders cancellation attempt finished.');
            } catch (cleanupError) {
                log('ERROR', 'Error during final cleanup:', cleanupError);
            }
        }
        process.exit(running ? 0 : 1);
    }
}

function handleShutdown(signal) {
    log('INFO', `Received ${signal}. Initiating graceful shutdown...`);
    if (running) {
        running = false;
        // Allow some time for the current cycle and cleanup in finally block
        // setTimeout(() => {
        //      log('WARN', 'Shutdown timeout reached. Forcing exit.');
        //      process.exit(1);
        // }, 10000); // 10 seconds grace period might be too long, adjust as needed
    } else {
        log('INFO', 'Shutdown already in progress.');
    }
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

main().catch(err => {
    log('ERROR', 'Unhandled error in main execution:', err);
    process.exit(1);
});