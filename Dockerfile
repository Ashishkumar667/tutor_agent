# Use official Node.js image
FROM node:20-alpine

# Create app directory
WORKDIR /app

# Install dependencies first (better caching)
COPY package*.json ./

RUN npm install

# Copy rest of the app
COPY . .

# Expose port (change if your app uses different port)
EXPOSE 5000

# Start the app
CMD ["npm", "start"]