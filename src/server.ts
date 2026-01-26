import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { PublicKey } from '@solana/web3.js';
import { NewPairsSubscription } from './lib/newpairs';
import { TransactionSubscription, TransactionEvent } from './lib/transactions';
import { getTokenInfo, getBondingCurveFromMint, getTopHolders } from './lib/tokeninfo';

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  if (req.url?.startsWith('/ws/')) {
    return next();
  }
  next();
});

const server = app.listen(PORT, () => {
  const green = '\x1b[32m';
  const white = '\x1b[37m';
  const reset = '\x1b[0m';
  
  console.log(`${green}
                                            
                                            
                          █████             
                      ████     ████         
                    ███           ███       
                   ██              ███      
                 ██                ████     
               ███                 ████     
              ███                  ████     
            ███████               █████     
          ███████████            █████      
        ███████████████        ██████       
       ██████████████████     █████         
      █████████████████████ ██████          
     ███████████████████████████            
     █████████████████████████              
     ████████████████████████               
     ██████████████████████                 
      ███████████████████                   
       █████████████████                    
         █████████████                      
             █████      ${white}PumpAPI ${green}v1.0${reset}                    
                                            
                                            
${reset}`);
  
  console.log(`\nServer running on port ${PORT}\n`);
  const borderWidth = 59;
  console.log(`${green}┌${'─'.repeat(borderWidth)}┐${reset}`);
  console.log(`${green}│${reset}              Available Endpoints                          ${green}│${reset}`);
  console.log(`${green}├${'─'.repeat(borderWidth)}┤${reset}`);
  console.log(`${green}│${reset}  WebSocket:                                               ${green}│${reset}`);
  const ws1 = `    - ws://localhost:${PORT}/ws/newpairs`;
  const ws2 = `    - ws://localhost:${PORT}/ws/txs?bondingCurve=[address]`;
  console.log(`${green}│${reset} ${ws1.padEnd(borderWidth - 1)}${green}│${reset}`);
  console.log(`${green}│${reset} ${ws2.padEnd(borderWidth - 1)}${green}│${reset}`);
  console.log(`${green}│${reset}${' '.repeat(borderWidth - 1)} ${green}│${reset}`);
  console.log(`${green}│${reset}  HTTP:                                                    ${green}│${reset}`);
  const http1 = `    - http://localhost:${PORT}/health`;
  const http2 = `    - http://localhost:${PORT}/status`;
  const http3 = `    - http://localhost:${PORT}/info/[mint]`;
  const http4 = `    - http://localhost:${PORT}/info/derive/[mint]`;
  const http5 = `    - http://localhost:${PORT}/topholders/[mint]`;
  const http6 = `    - http://localhost:${PORT}/`;
  console.log(`${green}│${reset} ${http1.padEnd(borderWidth - 1)}${green}│${reset}`);
  console.log(`${green}│${reset} ${http2.padEnd(borderWidth - 1)}${green}│${reset}`);
  console.log(`${green}│${reset} ${http3.padEnd(borderWidth - 1)}${green}│${reset}`);
  console.log(`${green}│${reset} ${http4.padEnd(borderWidth - 1)}${green}│${reset}`);
  console.log(`${green}│${reset} ${http5.padEnd(borderWidth - 1)}${green}│${reset}`);
  console.log(`${green}│${reset} ${http6.padEnd(borderWidth - 1)}${green}│${reset}`);
  console.log(`${green}└${'─'.repeat(borderWidth)}┘${reset}\n`);
  process.stdout.write(`${white}┌${'─'.repeat(borderWidth)}┐${reset}\n`);
  process.stdout.write(`${white}│${reset}              Connection Status                            ${white}│${reset}\n`);
  process.stdout.write(`${white}├${'─'.repeat(borderWidth)}┤${reset}\n`);
  process.stdout.write(`${white}│${reset}  New Pairs Clients: 0                                     ${white}│${reset}\n`);
  process.stdout.write(`${white}│${reset}  Transaction Subscriptions: 0                             ${white}│${reset}\n`);
  process.stdout.write(`${white}│${reset}  Total Transaction Clients: 0                            ${white}│${reset}\n`);
  process.stdout.write(`${white}└${'─'.repeat(borderWidth)}┘${reset}\n\n`);
  connectionStatusLineStart = 7;
});

const wssNewPairs = new WebSocketServer({ noServer: true });
const wssTransactions = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const pathname = (request.url || '').split('?')[0];
  
  if (pathname === '/ws/newpairs') {
    wssNewPairs.handleUpgrade(request, socket, head, (ws, req) => {
      wssNewPairs.emit('connection', ws, req);
    });
  } else if (pathname === '/ws/txs') {
    wssTransactions.handleUpgrade(request, socket, head, (ws, req) => {
      wssTransactions.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

const newPairsSubscription = new NewPairsSubscription();

const newPairsClients = new Set<any>();

wssNewPairs.on('connection', (ws, req) => {
  newPairsClients.add(ws);
  updateConnectionStatus();

  ws.on('close', () => {
    newPairsClients.delete(ws);
    updateConnectionStatus();
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    newPairsClients.delete(ws);
  });

  ws.on('message', (message) => {
    console.log('Received message from client:', message.toString());
  });

  try {
    const status = newPairsSubscription.getStatus();
    ws.send(JSON.stringify({
      type: 'connected',
      message: 'Connected to PumpAPI new pairs stream',
      subscriptionStatus: {
        subscribed: status.subscribed,
        eventCount: status.eventCount
      }
    }));
  } catch (error) {
    console.error('Error sending welcome message:', error);
  }
});

function broadcastNewPairs(data: any) {
  const message = JSON.stringify(data);
  newPairsClients.forEach((client) => {
    if (client.readyState === 1) { 
      try {
        client.send(message);
      } catch (error) {
        console.error('Error sending to client:', error);
      }
    }
  });
}

newPairsSubscription.onNewPair((event) => {
  broadcastNewPairs(event);
});

newPairsSubscription.subscribe().catch(console.error);

const transactionSubscriptions = new Map<string, {
  subscription: TransactionSubscription;
  clients: Set<WebSocket>;
}>();

let connectionStatusLineStart = 0;

const updateConnectionStatus = () => {
  const white = '\x1b[37m';
  const reset = '\x1b[0m';
  const borderWidth = 59;
  const totalTransactionClients = Array.from(transactionSubscriptions.values()).reduce((sum, sub) => sum + sub.clients.size, 0);
  
  if (connectionStatusLineStart > 0) {
    process.stdout.write(`\x1b[${connectionStatusLineStart}A`);
  }
  
  const lines = [
    `${white}┌${'─'.repeat(borderWidth)}┐${reset}`,
    `${white}│${reset}              Connection Status                            ${white}│${reset}`,
    `${white}├${'─'.repeat(borderWidth)}┤${reset}`,
    `${white}│${reset}  New Pairs Clients: ${newPairsClients.size.toString().padEnd(40)}${white}│${reset}`,
    `${white}│${reset}  Transaction Subscriptions: ${transactionSubscriptions.size.toString().padEnd(33)}${white}│${reset}`,
    `${white}│${reset}  Total Transaction Clients: ${totalTransactionClients.toString().padEnd(35)}${white}│${reset}`,
    `${white}└${'─'.repeat(borderWidth)}┘${reset}`
  ];
  
  for (let i = 0; i < lines.length; i++) {
    process.stdout.write(`\x1b[0G\x1b[2K${lines[i]}`);
    if (i < lines.length - 1) {
      process.stdout.write(`\n`);
    }
  }
  process.stdout.write(`\n`);
  
  connectionStatusLineStart = 7;
};

wssTransactions.on('connection', async (ws, req) => {
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });

  ws.on('close', (code, reason) => {
  });

  try {
    const urlString = req.url || '';
    let bondingCurve: string | null = null;
    
    try {
      const url = new URL(urlString, `http://${req.headers.host}`);
      bondingCurve = url.searchParams.get('bondingCurve');
    } catch (error) {
    }
    
    if (!bondingCurve) {
      const match1 = urlString.match(/\/ws\/txs\?=([A-Za-z0-9]{32,44})/);
      if (match1) {
        bondingCurve = match1[1];
      } else {
        const match2 = urlString.match(/\/ws\/txs\?bondingCurve=([A-Za-z0-9]{32,44})/);
        if (match2) {
          bondingCurve = match2[1];
        }
      }
    }
    
    if (!bondingCurve || !/^[A-Za-z0-9]{32,44}$/.test(bondingCurve)) {
      console.error(`Invalid bondingCurve parameter. URL: ${urlString}, Parsed: ${bondingCurve}`);
      ws.close(1008, 'Invalid bondingCurve parameter. Expected: /ws/txs?bondingCurve=[address] or /ws/txs?=[address]');
      return;
    }
    
    const clientInfo = {
      ip: req.socket.remoteAddress,
      path: req.url,
      bondingCurve
    };

    let subscriptionData = transactionSubscriptions.get(bondingCurve);
    
    if (!subscriptionData) {
      const subscription = new TransactionSubscription(bondingCurve);
      await subscription.subscribe();
      
      subscriptionData = {
        subscription,
        clients: new Set<WebSocket>()
      };
      
      transactionSubscriptions.set(bondingCurve, subscriptionData);
      
      subscription.onTransaction((event: TransactionEvent) => {
        const message = JSON.stringify(event);
        subscriptionData!.clients.forEach((client) => {
          if (client.readyState === 1) {
            try {
              client.send(message);
            } catch (error) {
              console.error('Error sending to transaction client:', error);
            }
          }
        });
      });
    }

    subscriptionData.clients.add(ws);
    updateConnectionStatus();

    const status = subscriptionData.subscription.getStatus();
    ws.send(JSON.stringify({
      type: 'connected',
      message: `Connected to transaction stream for bonding curve: ${bondingCurve}`,
      bondingCurve,
      subscriptionStatus: {
        subscribed: status.subscribed,
        eventCount: status.eventCount,
        programType: status.programType,
        programId: status.programId
      }
    }));

    ws.on('close', () => {
      subscriptionData?.clients.delete(ws);
      if (subscriptionData && subscriptionData.clients.size === 0) {
        try {
          subscriptionData.subscription.unsubscribe();
          transactionSubscriptions.delete(bondingCurve);
        } catch (error) {
          console.error(`Error unsubscribing:`, error);
        }
      }
      
      updateConnectionStatus();
    });

    ws.on('error', (error) => {
      console.error('Transaction WebSocket error:', error);
      subscriptionData?.clients.delete(ws);
      
      if (subscriptionData && subscriptionData.clients.size === 0) {
        try {
          subscriptionData.subscription.unsubscribe();
          transactionSubscriptions.delete(bondingCurve);
        } catch (unsubError) {
          console.error(`Error unsubscribing:`, unsubError);
        }
      }
      
      updateConnectionStatus();
    });

    ws.on('message', (message) => {
      console.log('Received message from transaction client:', message.toString());
    });

  } catch (error) {
    console.error('Error setting up transaction subscription:', error);
    console.error('Error stack:', error instanceof Error ? error.stack : 'No stack trace');
    try {
      ws.close(1011, `Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } catch (closeError) {
      console.error('Error closing WebSocket:', closeError);
    }
  }
});

app.get('/health', (req, res) => {
  const status = newPairsSubscription.getStatus();
  res.json({ 
    status: 'ok', 
    newPairsClients: newPairsClients.size,
    transactionSubscriptions: transactionSubscriptions.size,
    subscription: {
      subscribed: status.subscribed,
      eventCount: status.eventCount,
      lastEventTime: status.lastEventTime
    }
  });
});

app.get('/status', (req, res) => {
  const status = newPairsSubscription.getStatus();
  const connection = newPairsSubscription.getConnection();
  res.json({
    server: {
      port: PORT,
      running: true
    },
    websockets: {
      newPairs: {
        path: '/ws/newpairs',
        connectedClients: newPairsClients.size
      },
      transactions: {
        path: '/ws/txs?bondingCurve=[address]',
        activeSubscriptions: transactionSubscriptions.size,
        totalClients: Array.from(transactionSubscriptions.values())
          .reduce((sum, sub) => sum + sub.clients.size, 0)
      }
    },
    subscription: status,
    program: {
      id: newPairsSubscription.getProgramId().toString(),
      rpcUrl: connection.rpcEndpoint
    }
  });
});

app.get('/info/:mint', async (req, res) => {
  try {
    const { mint } = req.params;
    
    // Validate mint address format
    if (!mint || !/^[A-Za-z0-9]{32,44}$/.test(mint)) {
      return res.status(400).json({
        error: 'Invalid mint address',
        message: 'Mint address must be a valid Solana public key (32-44 alphanumeric characters)'
      });
    }

    // Try to validate it's a valid PublicKey
    try {
      new PublicKey(mint);
    } catch (pubkeyError) {
      return res.status(400).json({
        error: 'Invalid mint address',
        message: `Invalid Solana public key format: ${pubkeyError instanceof Error ? pubkeyError.message : 'Invalid format'}`
      });
    }

    const tokenInfo = await getTokenInfo(mint);
    res.json(tokenInfo);
  } catch (error) {
    console.error('Error fetching token info:', error);
    const statusCode = error instanceof Error && error.message.includes('Invalid mint') ? 400 : 500;
    res.status(statusCode).json({
      error: 'Failed to fetch token info',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

app.get('/info/derive/:mint', async (req, res) => {
  try {
    const { mint } = req.params;
    
    // Validate mint address format
    if (!mint || !/^[A-Za-z0-9]{32,44}$/.test(mint)) {
      return res.status(400).json({
        error: 'Invalid mint address',
        message: 'Mint address must be a valid Solana public key (32-44 alphanumeric characters)'
      });
    }

    // Try to validate it's a valid PublicKey
    try {
      new PublicKey(mint);
    } catch (pubkeyError) {
      return res.status(400).json({
        error: 'Invalid mint address',
        message: `Invalid Solana public key format: ${pubkeyError instanceof Error ? pubkeyError.message : 'Invalid format'}`
      });
    }

    const bondingCurveInfo = await getBondingCurveFromMint(mint);
    res.json(bondingCurveInfo);
  } catch (error) {
    console.error('Error fetching bonding curve:', error);
    const statusCode = error instanceof Error && error.message.includes('Invalid mint') ? 400 : 500;
    res.status(statusCode).json({
      error: 'Failed to fetch bonding curve',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

app.get('/topholders/:mint', async (req, res) => {
  try {
    const { mint } = req.params;
    
    if (!mint || !/^[A-Za-z0-9]{32,44}$/.test(mint)) {
      return res.status(400).json({
        error: 'Invalid mint address',
        message: 'Mint address must be a valid Solana public key (32-44 alphanumeric characters)'
      });
    }

    try {
      new PublicKey(mint);
    } catch (pubkeyError) {
      return res.status(400).json({
        error: 'Invalid mint address',
        message: `Invalid Solana public key format: ${pubkeyError instanceof Error ? pubkeyError.message : 'Invalid format'}`
      });
    }

    const topHolders = await getTopHolders(mint);
    res.json(topHolders);
  } catch (error) {
    console.error('Error fetching top holders:', error);
    const statusCode = error instanceof Error && error.message.includes('Invalid mint') ? 400 : 500;
    res.status(statusCode).json({
      error: 'Failed to fetch top holders',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

app.get('/', (req, res) => {
  res.json({
    message: 'PumpAPI WebSocket API',
    endpoints: {
      websockets: {
        newPairs: '/ws/newpairs',
        transactions: '/ws/txs?bondingCurve=[address]'
      },
      http: {
        health: '/health',
        status: '/status',
        tokenInfo: '/info/[mint]',
        bondingCurve: '/info/derive/[mint]',
        topHolders: '/topholders/[mint]'
      }
    }
  });
});

