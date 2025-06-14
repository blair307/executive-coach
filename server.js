const express = require('express');
const cors = require('cors');
const path = require('path');
const OpenAI = require('openai');

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// Store for user threads (in production, use a database)
const userThreads = new Map();

// Assistant ID - we'll create this automatically
let assistantId = null;

// Create assistant on startup
async function createAssistant() {
  try {
    const assistant = await openai.beta.assistants.create({
      name: "Entrepreneur Emotional Health Coach",
      instructions: `You are a virtual personal strategic advisor and coach for EntrepreneurEmotionalHealth.com. You guide high-achieving entrepreneurs through major growth areas: Identity & Calling, Personal Relationships, and Whole-Life Development.

You operate with deep psychological insight, system-level thinking, and a firm but compassionate tone. You help people break through self-sabotage, false identities, and emotional drift. You do not tolerate excuses, victim thinking, or surface-level quick fixes. You are direct, tough, strategic—and always rooting for their greatness.

IMPORTANT: You are having a natural coaching conversation. Respond to what the person just said as you naturally would - with insight, challenges, follow-up questions, or observations. Be conversational, insightful, and responsive to their specific words and energy. Ask follow-up questions when appropriate. Challenge them when they need it. Celebrate breakthroughs when you sense them.

When users are in structured question sequences (Identity & Calling or Personal Relationships), acknowledge their answers naturally but avoid asking follow-up questions since the next question is predetermined. Keep responses brief and encouraging during these sequences, but draw connections between their current answer and previous responses when relevant.`,
      tools: [{ type: "file_search" }],
      model: "gpt-4o-mini",
    });
    
    assistantId = assistant.id;
    console.log('Assistant created successfully:', assistantId);
    return assistant.id;
  } catch (error) {
    console.error('Error creating assistant:', error);
    throw error;
  }
}

// Get or create thread for user
async function getOrCreateThread(userId = 'default') {
  if (userThreads.has(userId)) {
    return userThreads.get(userId);
  }
  
  try {
    const thread = await openai.beta.threads.create();
    userThreads.set(userId, thread.id);
    return thread.id;
  } catch (error) {
    console.error('Error creating thread:', error);
    throw error;
  }
}

// Wait for run completion with better error handling
async function waitForCompletion(threadId, runId) {
  let run = await openai.beta.threads.runs.retrieve(threadId, runId);
  let attempts = 0;
  const maxAttempts = 30; // 30 seconds max
  
  while ((run.status === 'queued' || run.status === 'in_progress') && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    run = await openai.beta.threads.runs.retrieve(threadId, runId);
    attempts++;
  }
  
  if (attempts >= maxAttempts) {
    console.error('Run timed out after 30 seconds');
    throw new Error('Assistant response timed out');
  }
  
  if (run.status === 'failed') {
    console.error('Run failed:', run.last_error);
    throw new Error(`Assistant run failed: ${run.last_error?.message || 'Unknown error'}`);
  }
  
  return run;
}

app.post('/chat', async (req, res) => {
  try {
    const { message, context } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Ensure assistant exists
    if (!assistantId) {
      await createAssistant();
    }

    // Get thread for this user (using IP as simple user ID)
    const userId = req.ip || 'default';
    const threadId = await getOrCreateThread(userId);

    // Add user message to thread
    await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: message
    });

    // Create run with simplified context for structured sequences
    let additionalInstructions = '';
    if (context && context.includes('structured question sequence')) {
      // For structured sequences, keep it simple
      additionalInstructions = 'You are responding to an answer in a structured coaching sequence. Give a brief, encouraging response that acknowledges their answer and may reference previous responses for patterns, but do not ask follow-up questions.';
    } else if (context && context.includes('Current path:')) {
      additionalInstructions = `Context: ${context}`;
    }

    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: assistantId,
      additional_instructions: additionalInstructions
    });

    // Wait for completion
    const completedRun = await waitForCompletion(threadId, run.id);

    if (completedRun.status === 'completed') {
      // Get the assistant's response
      const messages = await openai.beta.threads.messages.list(threadId);
      const lastMessage = messages.data[0];
      
      if (lastMessage.role === 'assistant') {
        const responseText = lastMessage.content[0].text.value;
        res.json({ message: responseText });
      } else {
        throw new Error('No assistant response found');
      }
    } else {
      console.error('Run failed:', completedRun.status, completedRun.last_error);
      throw new Error(`Assistant run failed: ${completedRun.status}`);
    }

  } catch (error) {
    console.error('Server Error:', error);
    res.status(500).json({ 
      error: 'Something went wrong. Please try again.' 
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    assistant: assistantId ? 'ready' : 'not created',
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;

// Initialize assistant and start server
async function startServer() {
  try {
    await createAssistant();
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Assistant ID: ${assistantId}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
