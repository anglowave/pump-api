import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { NewPairsSubscription } from './lib/newpairs';
import { TransactionSubscription } from './lib/transactions';

const app = express();
const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// WebSocket server for new pairs
const wssNewPairs = new WebSocketServer({ server, path: '/ws/newpairs' });

// WebSocket server for transactions (will handle path routing manually)
// We'll use noServer and handle upgrade manually to support path-based routing
const wssTransactions = new WebSocketServer({ noServer: true });

// Handle WebSocket upgrade requests for transaction subscriptions
// Only handle /ws/txs, let wssNewPairs handle /ws/newpairs automatically
server.on('upgrade', (request, socket, head) => {
  const urlString = request.url || '';
  const pathname = urlString.split('?')[0]; // Get pathname before query string
  
  if (pathname === '/ws/txs') {
    wssTransactions.handleUpgrade(request, socket, head, (ws) => {
      wssTransactions.emit('connection', ws, request);
    });
  }
  // Don't destroy other paths - let other WebSocket servers handle them
});

const newPairsSubscription = new NewPairsSubscription();

const newPairsClients = new Set<any>();

wssNewPairs.on('connection', (ws, req) => {
  const clientInfo = {
    ip: req.socket.remoteAddress,
    path: req.url
  };
  console.log(`✓ New WebSocket client connected from ${clientInfo.ip} to ${clientInfo.path}`);
  console.log(`  Total clients: ${newPairsClients.size + 1}`);
  newPairsClients.add(ws);

  ws.on('close', () => {
    console.log(`✗ WebSocket client disconnected. Remaining: ${newPairsClients.size - 1}`);
    newPairsClients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('✗ WebSocket error:', error);
    newPairsClients.delete(ws);
  });

  ws.on('message', (message) => {
    console.log('Received message from client:', message.toString());
  });

  try {
    const status = newPairsSubscription.getStatus();
    ws.send(JSON.stringify({
      type: 'connected',
      message: 'Connected to Pumpfun new pairs stream',
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

// Transaction subscriptions map: bondingCurve -> { subscription, clients }
const transactionSubscriptions = new Map<string, {
  subscription: TransactionSubscription;
  clients: Set<WebSocket>;
}>();

// WebSocket handler for transactions
wssTransactions.on('connection', async (ws, req) => {
  const urlString = req.url || '';
  let bondingCurve: string | null = null;
  
  // Parse URL - handle both ?bondingCurve=value and ?=value formats
  try {
    // First try to parse as standard URL
    const url = new URL(urlString, `http://${req.headers.host}`);
    bondingCurve = url.searchParams.get('bondingCurve');
  } catch (error) {
    // URL parsing failed, will try manual parsing below
  }
  
  // If no bondingCurve param found, try manual parsing for ?=value format
  if (!bondingCurve) {
    // Match ?=value format
    const match1 = urlString.match(/\/ws\/txs\?=([A-Za-z0-9]{32,44})/);
    if (match1) {
      bondingCurve = match1[1];
    } else {
      // Also try ?bondingCurve=value format manually
      const match2 = urlString.match(/\/ws\/txs\?bondingCurve=([A-Za-z0-9]{32,44})/);
      if (match2) {
        bondingCurve = match2[1];
      }
    }
  }
  
  if (!bondingCurve || !/^[A-Za-z0-9]{32,44}$/.test(bondingCurve)) {
    console.error(`✗ Invalid bondingCurve parameter. URL: ${urlString}`);
    ws.close(1008, 'Invalid bondingCurve parameter. Expected: /ws/txs?bondingCurve=[address] or /ws/txs?=[address]');
    return;
  }
  const clientInfo = {
    ip: req.socket.remoteAddress,
    path: req.url,
    bondingCurve
  };

  console.log(`✓ New transaction WebSocket client connected from ${clientInfo.ip}`);
  console.log(`  Bonding curve: ${bondingCurve}`);
  console.log(`  Path: ${req.url}`);

  try {
    // Get or create subscription for this bonding curve
    let subscriptionData = transactionSubscriptions.get(bondingCurve);
    
    if (!subscriptionData) {
      // Create new subscription
      const subscription = new TransactionSubscription(bondingCurve);
      await subscription.subscribe();
      
      subscriptionData = {
        subscription,
        clients: new Set<WebSocket>()
      };
      
      transactionSubscriptions.set(bondingCurve, subscriptionData);
      
      // Set up callback to broadcast to all clients for this bonding curve
      subscription.onTransaction((event) => {
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
      
      console.log(`✓ Created new subscription for bonding curve: ${bondingCurve}`);
    }

    // Add client to this subscription
    subscriptionData.clients.add(ws);
    const totalClients = subscriptionData.clients.size;
    console.log(`  Total clients for this bonding curve: ${totalClients}`);

    // Send welcome message
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

    // Handle client disconnect
    ws.on('close', () => {
      console.log(`✗ Transaction WebSocket client disconnected for bonding curve: ${bondingCurve}`);
      subscriptionData?.clients.delete(ws);
      
      // If no more clients, unsubscribe (optional - you might want to keep it active)
      if (subscriptionData && subscriptionData.clients.size === 0) {
        console.log(`  No more clients for ${bondingCurve}, keeping subscription active`);
        // Optionally unsubscribe: subscriptionData.subscription.unsubscribe();
      }
    });

    ws.on('error', (error) => {
      console.error('✗ Transaction WebSocket error:', error);
      subscriptionData?.clients.delete(ws);
    });

    ws.on('message', (message) => {
      console.log('Received message from transaction client:', message.toString());
    });

  } catch (error) {
    console.error('✗ Error setting up transaction subscription:', error);
    ws.close(1011, `Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
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

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Pumpfun WebSocket API',
    endpoints: {
      websockets: {
        newPairs: '/ws/newpairs',
        transactions: '/ws/txs?bondingCurve=[address]'
      },
      health: '/health',
      status: '/status'
    }
  });
});

