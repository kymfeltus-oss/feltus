import { FeltusBaseClient } from './lib/feltus-client.js';
import { FeltusAIController } from './lib/feltus-ai.js';
import dotenv from 'dotenv';

// Automatically process your .env keys
dotenv.config();

console.log('=== FELTUS LABS: ENGINE INITIALIZATION BOOTSTRAP ===');
console.log(`Target Registry Endpoint: ${process.env.FELTUS_API_URL || 'http://127.0.0'}`);

// Initialize data transport and inference wrappers
const feltusData = new FeltusBaseClient(process.env.FELTUS_API_URL || 'http://127.0.0');
const feltusAI = new FeltusAIController();

console.log('Status: Pipelines initialized successfully. Ready for operations.');
