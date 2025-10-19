const express = require('express');
const { body, validationResult } = require('express-validator');
const { db } = require('../config/firebase');
const User = require('../models/User');
const { awardPointsForOrder } = require('./points');

const router = express.Router();

// Get delivery profile by email and password
router.post('/profile', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 1 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;
    const user = await User.findByEmail(email);
    
    if (!user || user.password !== password || user.role !== 'delivery') {
      return res.status(401).json({ error: 'Invalid credentials or not a delivery rider' });
    }

    res.json({ 
      user: user.toJSON()
    });
  } catch (error) {
    console.error('Get delivery profile error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get assigned orders for delivery rider
router.get('/orders', async (req, res) => {
  try {
    const { riderId } = req.query;
    
    if (!riderId) {
      return res.status(400).json({ error: 'Rider ID required' });
    }

    // Get orders assigned to this rider
    const ordersSnapshot = await db.collection('orders')
      .where('deliveryPartnerId', '==', riderId)
      .get();
    
    const orders = ordersSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate?.() || new Date(),
      updatedAt: doc.data().updatedAt?.toDate?.() || new Date()
    }));

    res.json({ orders });
  } catch (error) {
    console.error('Get delivery orders error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Accept delivery assignment (first-come-first-serve)
router.post('/accept/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { riderId } = req.body;

    if (!riderId) {
      return res.status(400).json({ error: 'Rider ID required' });
    }

    // Check if order is still available (not assigned to another rider)
    const orderDoc = await db.collection('orders').doc(orderId).get();
    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const orderData = orderDoc.data();
    
    // Check if order is still available for assignment
    if (orderData.deliveryPartnerId !== null) {
      return res.status(409).json({ error: 'Order has already been assigned to another rider' });
    }

    if (orderData.status !== 'ready') {
      return res.status(400).json({ error: 'Order is not ready for delivery' });
    }

    // Check if rider is available
    const rider = await User.findById(riderId);
    if (!rider || rider.deliveryStatus !== 'free') {
      return res.status(400).json({ error: 'Rider is not available' });
    }

    // Assign order to rider (first-come-first-serve)
    const orderRef = db.collection('orders').doc(orderId);
    await orderRef.update({
      status: 'out_for_delivery',
      deliveryPartnerId: riderId,
      assignedAt: new Date(),
      updatedAt: new Date()
    });

    // Update rider status to busy
    await rider.updateDeliveryStatus('busy');

    res.json({
      message: 'Order accepted successfully',
      orderId: orderId,
      status: 'out_for_delivery'
    });
  } catch (error) {
    console.error('Accept delivery error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Reject delivery assignment (remove assignment, make available again)
router.post('/reject/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { riderId } = req.body;

    if (!riderId) {
      return res.status(400).json({ error: 'Rider ID required' });
    }

    // Remove rider assignment - order becomes available for other riders
    const orderRef = db.collection('orders').doc(orderId);
    await orderRef.update({
      deliveryPartnerId: null,
      assignedAt: null,
      status: 'ready', // Reset to ready status
      updatedAt: new Date()
    });

    res.json({
      message: 'Order rejected, now available for other riders',
      orderId: orderId
    });
  } catch (error) {
    console.error('Reject delivery error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mark order as picked up
router.post('/pickup/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { riderId } = req.body;

    if (!riderId) {
      return res.status(400).json({ error: 'Rider ID required' });
    }

    // Update order status
    const orderRef = db.collection('orders').doc(orderId);
    await orderRef.update({
      status: 'out_for_delivery',
      pickedUpAt: new Date(),
      updatedAt: new Date()
    });

    res.json({
      message: 'Order picked up successfully',
      orderId: orderId,
      status: 'out_for_delivery'
    });
  } catch (error) {
    console.error('Pickup order error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mark order as delivered
router.post('/deliver/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { riderId } = req.body;

    if (!riderId) {
      return res.status(400).json({ error: 'Rider ID required' });
    }

    // Get order details first
    const orderDoc = await db.collection('orders').doc(orderId).get();
    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const orderData = orderDoc.data();

    // Update order status
    const orderRef = db.collection('orders').doc(orderId);
    await orderRef.update({
      status: 'delivered',
      deliveredAt: new Date(),
      updatedAt: new Date()
    });

    // Award points to customer
    await awardPointsForOrder(orderData.customerId, orderData.totalAmount);

    // Update rider status to free
    const rider = await User.findById(riderId);
    if (rider) {
      await rider.updateDeliveryStatus('free');
    }

    res.json({
      message: 'Order delivered successfully',
      orderId: orderId,
      status: 'delivered'
    });
  } catch (error) {
    console.error('Deliver order error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get available orders for assignment
router.get('/available', async (req, res) => {
  try {
    // Get orders that are ready but not yet assigned
    const ordersSnapshot = await db.collection('orders')
      .where('status', '==', 'ready')
      .where('deliveryPartnerId', '==', null)
      .get();
    
    const orders = ordersSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate?.() || new Date(),
      updatedAt: doc.data().updatedAt?.toDate?.() || new Date()
    }));

    res.json({ orders });
  } catch (error) {
    console.error('Get available orders error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;