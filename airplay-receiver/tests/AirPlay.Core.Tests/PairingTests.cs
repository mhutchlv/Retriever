using AirPlay.Crypto;
using AirPlay.Pairing;
using Xunit;

namespace AirPlay.Tests;

public class PairingTests
{
    /// <summary>Client side of pair-verify, as an iPhone would do it.</summary>
    internal sealed class SimulatedClient
    {
        public byte[] EdSeed { get; } = Ed25519Keys.GenerateSeed();
        public byte[] EdPublic { get; }
        public byte[] EcdhPrivate { get; }
        public byte[] EcdhPublic { get; }
        public byte[]? Secret { get; private set; }
        public byte[]? ReceiverEcdhPublic { get; private set; }

        public SimulatedClient()
        {
            EdPublic = Ed25519Keys.PublicKeyFromSeed(EdSeed);
            (EcdhPrivate, EcdhPublic) = X25519Keys.GenerateKeyPair();
        }

        public byte[] Step1Request()
        {
            var req = new byte[68];
            req[0] = 1;
            EcdhPublic.CopyTo(req, 4);
            EdPublic.CopyTo(req, 36);
            return req;
        }

        /// <summary>Checks the receiver's signature and builds the step 2 request.</summary>
        public byte[] Step2Request(byte[] step1Response, byte[] receiverEdPublic)
        {
            Assert.Equal(96, step1Response.Length);
            ReceiverEcdhPublic = step1Response[..32];
            Secret = X25519Keys.SharedSecret(EcdhPrivate, ReceiverEcdhPublic);
            using var ctr = new AesCtr(AirPlayKeys.PairVerifyAesKey(Secret), AirPlayKeys.PairVerifyAesIv(Secret));
            var signature = ctr.Transform(step1Response.AsSpan(32, 64));
            var signed = new byte[64];
            ReceiverEcdhPublic.CopyTo(signed, 0);
            EcdhPublic.CopyTo(signed, 32);
            Assert.True(Ed25519Keys.Verify(signature, receiverEdPublic, signed), "receiver signature must verify");

            var mine = new byte[64];
            EcdhPublic.CopyTo(mine, 0);
            ReceiverEcdhPublic.CopyTo(mine, 32);
            var mySig = Ed25519Keys.Sign(EdSeed, EdPublic, mine);
            var encrypted = ctr.Transform(mySig); // keystream continues after the first 64 bytes
            var req = new byte[68];
            encrypted.CopyTo(req, 4);
            return req;
        }
    }

    [Fact]
    public void FullPairVerifyRoundTrip()
    {
        var identity = ReceiverIdentity.Generate();
        var session = new PairingSession(identity);
        var client = new SimulatedClient();

        var setupReply = session.Setup(client.EdPublic);
        Assert.Equal(identity.PublicKey, setupReply);
        Assert.Equal(PairingStatus.Setup, session.Status);

        var step1 = session.VerifyStep1(client.Step1Request());
        Assert.Equal(PairingStatus.Handshake, session.Status);
        var step2 = client.Step2Request(step1, identity.PublicKey);
        Assert.True(session.VerifyStep2(step2));
        Assert.Equal(PairingStatus.Finished, session.Status);
        Assert.Equal(client.Secret, session.EcdhSecret);
        Assert.Equal(client.EdPublic, session.ClientPublicKey);
    }

    [Fact]
    public void TamperedSignatureIsRejected()
    {
        var identity = ReceiverIdentity.Generate();
        var session = new PairingSession(identity);
        var client = new SimulatedClient();
        session.Setup(client.EdPublic);
        var step2 = client.Step2Request(session.VerifyStep1(client.Step1Request()), identity.PublicKey);
        step2[10] ^= 0x55;
        Assert.False(session.VerifyStep2(step2));
        Assert.Equal(PairingStatus.Handshake, session.Status);
    }

    [Fact]
    public void IdentityIsStableFromDeviceIdAndFile()
    {
        var a = ReceiverIdentity.FromDeviceId("aa:bb:cc:dd:ee:ff");
        var b = ReceiverIdentity.FromDeviceId("aa:bb:cc:dd:ee:ff");
        Assert.Equal(a.PublicKey, b.PublicKey);
        Assert.NotEqual(a.PublicKey, ReceiverIdentity.FromDeviceId("aa:bb:cc:dd:ee:00").PublicKey);

        var path = Path.Combine(Path.GetTempPath(), "airplay-test-" + Guid.NewGuid().ToString("N") + ".key");
        try
        {
            var first = ReceiverIdentity.LoadOrCreate(path);
            var second = ReceiverIdentity.LoadOrCreate(path);
            Assert.Equal(first.PublicKey, second.PublicKey);
            Assert.Equal(64, first.PublicKeyHex.Length);
        }
        finally
        {
            File.Delete(path);
        }
    }
}
