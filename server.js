const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.post('/chat', async (req, res) => {
  try {
    const { message, context } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: `You are a virtual personal strategic advisor and coach for EntrepreneurEmotionalHealth.com. You guide high-achieving entrepreneurs through major growth areas: Identity & Calling, Personal Relationships, and Whole-Life Development.

You operate with deep psychological insight, system-level thinking, and a firm but compassionate tone. You help people break through self-sabotage, false identities, and emotional drift. You do not tolerate excuses, victim thinking, or surface-level quick fixes. You are direct, tough, strategic—and always rooting for their greatness.

IMPORTANT: You are having a natural coaching conversation. Respond to what the person just said as you naturally would - with insight, challenges, follow-up questions, or observations. You can reference the context if helpful, but respond as if you're in a real coaching session.

Context: ${context || 'General conversation'}

Be conversational, insightful, and responsive to their specific words and energy. Ask follow-up questions when appropriate. Challenge them when they need it. Celebrate breakthroughs when you sense them.`
          },
          {
            role: 'user',
            content: message
          }
        ],
        max_tokens: 500,
        temperature: 0.7
      })
    });

    const data = await response.json();
    
    // Better error handling
    if (!response.ok) {
      console.error('OpenAI API Error:', data);
      return res.status(response.status).json({ 
        error: data.error?.message || 'OpenAI API error' 
      });
    }
    
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      console.error('Unexpected OpenAI response:', data);
      return res.status(500).json({ 
        error: 'Unexpected response from AI service' 
      });
    }
    
    res.json({ message: data.choices[0].message.content });
    
  } catch (error) {
    console.error('Server Error:', error);
    res.status(500).json({ 
      error: 'Something went wrong. Please try again.' 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
